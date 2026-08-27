import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  ExternalWorkProviderError,
} from "../server/external-work-providers.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function createControlledProvider() {
  const state = {
    configured: false,
    failSync: false,
    mutations: [],
    statusMappings: [],
  };
  return {
    state,
    provider: {
      id: "controlled",
      displayName: "Controlled provider",
      supportedMutations: ["title", "status"],
      localOnlyMutations: ["developmentContext"],
      async getConnection() {
        return {
          configured: state.configured,
          endpoint: state.configured ? "https://work.example.test" : null,
        };
      },
      async configure(configuration) {
        state.configured = true;
        state.failSync = configuration.failSync === true;
      },
      async discoverProjects() {
        return [{
          id: "controlled-project",
          name: "Controlled project",
          labels: ["external"],
          externalOrigin: "tenant-1",
          externalId: "project-7",
          externalUrl: "https://work.example.test/projects/7",
        }];
      },
      async synchronize() {
        if (state.failSync) {
          throw new ExternalWorkProviderError(
            502,
            "CONTROLLED_SYNC_FAILED",
            "Controlled synchronization failed",
          );
        }
        return {
          projects: await this.discoverProjects(),
          tasks: [{
            projectId: "controlled-project",
            identifier: "CTRL-42",
            title: "Provider task",
            description: "Synchronized through the public API",
            remoteStatus: "active",
            priority: "high",
            labels: ["external"],
            externalOrigin: "tenant-1",
            externalId: "work-item-42",
            externalKey: "CTRL-42",
            externalUrl: "https://work.example.test/items/42",
            creator: { id: "remote-user", name: "Remote user" },
            assignee: { id: "remote-user", name: "Remote user" },
            createdAt: "2026-08-26T00:00:00.000Z",
            updatedAt: "2026-08-26T00:00:00.000Z",
          }],
        };
      },
      mapStatus(remoteStatus) {
        state.statusMappings.push(remoteStatus);
        return remoteStatus === "active" ? "in_progress" : "done";
      },
      async mutateTask(request) {
        if (request.changes.title === "Rejected title") {
          throw new ExternalWorkProviderError(
            409,
            "CONTROLLED_MUTATION_REJECTED",
            "Controlled mutation rejected",
          );
        }
        state.mutations.push(request);
      },
    },
  };
}

async function startServer(provider) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-provider-test-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    externalWorkProviders: [provider],
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function nextEvent(response, eventType) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`Event stream ended before '${eventType}'`);
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split("\n\n");
    buffer = messages.pop();
    for (const message of messages) {
      if (!message.includes(`event: ${eventType}\n`)) continue;
      const data = message.split("\n").find((line) => line.startsWith("data: "));
      await reader.cancel();
      return JSON.parse(data.slice(6));
    }
  }
}

test("a controlled external provider is observable through the public server API", async () => {
  const controlled = createControlledProvider();
  const baseUrl = await startServer(controlled.provider);

  const providers = await request(baseUrl, "/api/external-work/providers");
  assert.equal(providers.response.status, 200);
  assert.deepEqual(providers.body.providers.find((provider) => provider.id === "controlled"), {
    id: "controlled",
    displayName: "Controlled provider",
    connection: { configured: false, endpoint: null },
    supportedMutations: ["title", "status"],
    localOnlyMutations: ["developmentContext"],
  });

  const connection = await request(
    baseUrl,
    "/api/external-work/providers/controlled/connection",
    { method: "PUT", body: { endpoint: "https://work.example.test" } },
  );
  assert.equal(connection.response.status, 200);
  assert.equal(connection.body.provider.connection.configured, true);

  const discovery = await request(
    baseUrl,
    "/api/external-work/providers/controlled/projects",
  );
  assert.equal(discovery.response.status, 200);
  assert.deepEqual(discovery.body.projects[0], {
    id: "controlled-project",
    name: "Controlled project",
    labels: ["external"],
    externalOrigin: "tenant-1",
    externalId: "project-7",
    externalUrl: "https://work.example.test/projects/7",
    source: "controlled",
  });

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const eventPromise = nextEvent(eventResponse, "external-work.synced");
  const synchronization = await request(
    baseUrl,
    "/api/external-work/providers/controlled/sync",
    { method: "POST" },
  );
  assert.equal(synchronization.response.status, 200);
  const task = synchronization.body.tasks[0];
  assert.equal(task.source, "controlled");
  assert.equal(task.status, "in_progress");
  assert.equal(task.externalOrigin, "tenant-1");
  assert.equal(task.externalId, "work-item-42");
  assert.equal(task.externalKey, "CTRL-42");
  assert.equal(task.externalUrl, "https://work.example.test/items/42");
  assert.deepEqual(controlled.state.statusMappings, ["active"]);

  const event = await eventPromise;
  assert.equal(event.providerId, "controlled");
  assert.deepEqual(event.projectIds, ["controlled-project"]);
  assert.deepEqual(event.taskIds, [task.id]);

  const projects = await request(baseUrl, "/api/projects");
  const project = projects.body.projects.find((candidate) => candidate.id === "controlled-project");
  assert.equal(project.source, "controlled");
  assert.equal(project.externalOrigin, "tenant-1");
  assert.equal(project.externalId, "project-7");
  assert.equal(project.externalUrl, "https://work.example.test/projects/7");

  const tasks = await request(baseUrl, "/api/tasks?projectId=controlled-project");
  assert.equal(tasks.body.tasks[0].id, task.id);
  assert.equal(tasks.body.tasks[0].externalId, "work-item-42");

  const secondSync = await request(
    baseUrl,
    "/api/external-work/providers/controlled/sync",
    { method: "POST" },
  );
  assert.equal(secondSync.body.tasks[0].id, task.id);
  assert.equal(secondSync.body.tasks[0].version, task.version);

  const updated = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: {
      version: secondSync.body.tasks[0].version,
      title: "Updated remotely",
      developmentContext: { type: "branch", branch: "provider-rework" },
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.task.title, "Updated remotely");
  assert.deepEqual(updated.body.task.developmentContext, {
    type: "branch",
    branch: "provider-rework",
  });
  assert.deepEqual(controlled.state.mutations[0], {
    identity: {
      providerId: "controlled",
      origin: "tenant-1",
      id: "work-item-42",
      key: "CTRL-42",
      url: "https://work.example.test/items/42",
    },
    changes: { title: "Updated remotely" },
  });

  const staleMove = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/move`, {
    method: "POST",
    body: { version: task.version, status: "done", sortOrder: 1024 },
  });
  assert.equal(staleMove.response.status, 409);
  assert.equal(staleMove.body.error.code, "VERSION_CONFLICT");
  assert.equal(controlled.state.mutations.length, 1);

  const rejected = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: { version: updated.body.task.version, title: "Rejected title" },
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "CONTROLLED_MUTATION_REJECTED");
  const unchanged = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`);
  assert.equal(unchanged.body.task.title, "Updated remotely");

  const unsupported = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: { version: updated.body.task.version, priority: "urgent" },
  });
  assert.equal(unsupported.response.status, 409);
  assert.equal(unsupported.body.error.code, "EXTERNAL_MUTATION_UNSUPPORTED");

  await request(baseUrl, "/api/external-work/providers/controlled/connection", {
    method: "PUT",
    body: { failSync: true },
  });
  const failedSync = await request(
    baseUrl,
    "/api/external-work/providers/controlled/sync",
    { method: "POST" },
  );
  assert.equal(failedSync.response.status, 502);
  assert.equal(failedSync.body.error.code, "CONTROLLED_SYNC_FAILED");
});
