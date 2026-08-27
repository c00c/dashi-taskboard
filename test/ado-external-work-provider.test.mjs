import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function createAdoFixture() {
  const state = {
    title: "Synchronize ADO work",
    remoteStatus: "Active",
    requests: [],
  };

  return {
    state,
    async fetch(input, init = {}) {
      const url = new URL(input);
      state.requests.push({
        method: init.method ?? "GET",
        pathname: url.pathname,
        apiVersion: url.searchParams.get("api-version"),
        authorization: init.headers?.authorization,
        body: init.body ? JSON.parse(init.body) : null,
      });

      if (url.pathname === "/example-org/project-one/_apis/git/repositories") {
        return Response.json({
          count: 1,
          value: [{
            id: "11111111-1111-1111-1111-111111111111",
            name: "taskboard",
            webUrl: "https://dev.azure.com/example-org/project-one/_git/taskboard",
            project: {
              id: "22222222-2222-2222-2222-222222222222",
              name: "Project One",
            },
          }],
        });
      }

      if (url.pathname === "/example-org/project-one/_apis/wit/workitemsbatch") {
        return Response.json({
          count: 1,
          value: [{
            id: 42,
            rev: 7,
            fields: {
              "System.Id": 42,
              "System.Title": state.title,
              "System.Description": "Imported through Azure DevOps",
              "System.State": state.remoteStatus,
              "System.Tags": "ado; integration",
              "System.AssignedTo": {
                id: "ado-user-id",
                displayName: "ADO User",
                uniqueName: "ado@example.test",
              },
              "System.CreatedBy": {
                id: "ado-creator-id",
                displayName: "ADO Creator",
                uniqueName: "creator@example.test",
              },
              "System.CreatedDate": "2026-08-20T00:00:00.000Z",
              "System.ChangedDate": "2026-08-26T00:00:00.000Z",
              "Microsoft.VSTS.Common.Priority": 2,
            },
          }],
        });
      }

      throw new Error(`Unexpected ADO request: ${init.method ?? "GET"} ${url.pathname}`);
    },
  };
}

async function startServer(adoFetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-provider-test-"));
  const app = createTaskboardServer({ dataDirectory: directory, adoFetch });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  runningApps.push({ app, directory });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    configPath: path.join(directory, "external-work", "ado.json"),
  };
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

function configuration(workspacePath, overrides = {}) {
  return {
    organization: "example-org",
    personalAccessToken: "ado-secret",
    projects: [{
      id: "project-one",
      name: "Project One",
      repositories: [{
        id: "11111111-1111-1111-1111-111111111111",
        workspacePath,
        workItemIds: [42],
      }],
    }],
    stateMapping: {
      New: "todo",
      Active: "in_progress",
      Resolved: "in_review",
      Closed: "done",
    },
    ...overrides,
  };
}

test("ADO discovery and synchronization are observable through the public provider API", async () => {
  const ado = createAdoFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-workspace-"));
  const { baseUrl, configPath } = await startServer(ado.fetch);

  try {
    const configured = await request(
      baseUrl,
      "/api/external-work/providers/ado/connection",
      { method: "PUT", body: configuration(directory) },
    );
    assert.equal(configured.response.status, 200);
    assert.deepEqual(configured.body.provider.connection, {
      configured: true,
      organization: "example-org",
      projects: [{
        id: "project-one",
        name: "Project One",
        repositories: [{
          id: "11111111-1111-1111-1111-111111111111",
          workspacePath: directory,
          workItemIds: [42],
        }],
      }],
      stateMapping: {
        New: "todo",
        Active: "in_progress",
        Resolved: "in_review",
        Closed: "done",
      },
    });
    assert.equal(JSON.stringify(configured.body).includes("ado-secret"), false);
    assert.equal((await readFile(configPath, "utf8")).includes("ado-secret"), true);

    const providers = await request(baseUrl, "/api/external-work/providers");
    const provider = providers.body.providers.find((candidate) => candidate.id === "ado");
    assert.deepEqual(provider.supportedMutations, []);
    assert.equal(provider.connection.organization, "example-org");

    const discovery = await request(baseUrl, "/api/external-work/providers/ado/projects");
    assert.equal(discovery.response.status, 200);
    assert.deepEqual(discovery.body.projects, [{
      id: "ado-11111111-1111-1111-1111-111111111111",
      name: "Project One · taskboard",
      labels: ["ado"],
      workspacePath: directory,
      repository: {
        id: "11111111-1111-1111-1111-111111111111",
        name: "taskboard",
        projectId: "22222222-2222-2222-2222-222222222222",
        projectName: "Project One",
      },
      externalOrigin: "ado:example-org",
      externalId: "11111111-1111-1111-1111-111111111111",
      externalUrl: "https://dev.azure.com/example-org/project-one/_git/taskboard",
      source: "ado",
    }]);

    const eventResponse = await fetch(`${baseUrl}/api/events`);
    const eventPromise = nextEvent(eventResponse, "external-work.synced");
    const synchronized = await request(
      baseUrl,
      "/api/external-work/providers/ado/sync",
      { method: "POST" },
    );
    assert.equal(synchronized.response.status, 200);
    assert.equal(synchronized.body.tasks.length, 1);
    const task = synchronized.body.tasks[0];
    assert.equal(task.source, "ado");
    assert.equal(task.status, "in_progress");
    assert.equal(task.priority, "high");
    assert.equal(task.externalOrigin, "ado:example-org");
    assert.equal(task.externalId, "42");
    assert.equal(task.externalKey, "42");
    assert.equal(
      task.externalUrl,
      "https://dev.azure.com/example-org/project-one/_workitems/edit/42",
    );
    assert.deepEqual(task.labels, ["ado", "integration"]);

    const event = await eventPromise;
    assert.equal(event.providerId, "ado");
    assert.deepEqual(event.projectIds, ["ado-11111111-1111-1111-1111-111111111111"]);
    assert.deepEqual(event.taskIds, [task.id]);

    const projects = await request(baseUrl, "/api/projects");
    const project = projects.body.projects.find((candidate) => candidate.source === "ado");
    assert.equal(project.workspacePath, directory);
    assert.equal(project.externalId, "11111111-1111-1111-1111-111111111111");

    const firstVersion = task.version;
    const refreshed = await request(
      baseUrl,
      "/api/external-work/providers/ado/sync",
      { method: "POST" },
    );
    assert.equal(refreshed.body.tasks[0].id, task.id);
    assert.equal(refreshed.body.tasks[0].version, firstVersion);

    ado.state.title = "Synchronize refreshed ADO work";
    const updated = await request(
      baseUrl,
      "/api/external-work/providers/ado/sync",
      { method: "POST" },
    );
    assert.equal(updated.body.tasks[0].id, task.id);
    assert.equal(updated.body.tasks[0].title, "Synchronize refreshed ADO work");
    assert.equal(updated.body.tasks[0].version, firstVersion + 1);

    assert.equal(ado.state.requests.every((entry) => entry.apiVersion === "7.1"), true);
    assert.equal(
      ado.state.requests.every(
        (entry) => entry.authorization === `Basic ${Buffer.from(":ado-secret").toString("base64")}`,
      ),
      true,
    );
    const batch = ado.state.requests.find(
      (entry) => entry.pathname.endsWith("/_apis/wit/workitemsbatch"),
    );
    assert.deepEqual(batch.body.ids, [42]);
    assert.equal(batch.body.ids.length <= 200, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ADO rejects unmapped states without partially persisting a snapshot", async () => {
  const ado = createAdoFixture();
  ado.state.remoteStatus = "Committed";
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-unmapped-workspace-"));
  const { baseUrl } = await startServer(ado.fetch);

  try {
    const configured = await request(
      baseUrl,
      "/api/external-work/providers/ado/connection",
      { method: "PUT", body: configuration(directory) },
    );
    assert.equal(configured.response.status, 200);

    const failed = await request(
      baseUrl,
      "/api/external-work/providers/ado/sync",
      { method: "POST" },
    );
    assert.equal(failed.response.status, 409);
    assert.equal(failed.body.error.code, "ADO_STATE_UNMAPPED");
    assert.equal(failed.body.error.message.includes("Committed"), true);
    assert.equal(JSON.stringify(failed.body).includes("ado-secret"), false);

    const projects = await request(baseUrl, "/api/projects");
    assert.equal(projects.body.projects.some((project) => project.source === "ado"), false);
    const tasks = await request(baseUrl, "/api/tasks");
    assert.equal(tasks.body.tasks.some((task) => task.source === "ado"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
