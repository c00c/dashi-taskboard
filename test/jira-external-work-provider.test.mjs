import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

function createJiraFixture() {
  const state = {
    issues: [{
      id: "10001",
      key: "TASK-7",
      fields: {
        summary: "Existing Jira task",
        description: "Imported through Jira",
        status: { name: "To Do", statusCategory: { key: "new" } },
        priority: { name: "High" },
        labels: ["jira-label"],
        duedate: "2026-09-01",
        assignee: { key: "jira-user", displayName: "Jira User" },
        reporter: { key: "reporter", displayName: "Reporter" },
        created: "2026-08-20T00:00:00.000Z",
        updated: "2026-08-25T00:00:00.000Z",
      },
    }],
    issueUpdates: [],
    transitions: [],
  };

  return {
    state,
    async fetch(input, init = {}) {
      const url = new URL(input);
      const pathname = url.pathname;
      if (pathname === "/rest/applinks/1.0/manifest") {
        return Response.json({ id: "jira-instance-1" });
      }
      if (pathname === "/rest/api/2/myself") {
        return Response.json({ key: "jira-user", displayName: "Jira User" });
      }
      if (pathname === "/rest/api/2/search") {
        return Response.json({ issues: state.issues, total: state.issues.length });
      }
      if (pathname === "/rest/api/2/priority") {
        return Response.json([{ id: "2", name: "Highest" }]);
      }
      if (pathname === "/rest/api/2/issue/TASK-7" && init.method === "PUT") {
        state.issueUpdates.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (pathname === "/rest/api/2/issue/TASK-7/transitions" && init.method !== "POST") {
        return Response.json({
          transitions: [{
            id: "31",
            name: "Start progress",
            to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          }],
        });
      }
      if (pathname === "/rest/api/2/issue/TASK-7/transitions" && init.method === "POST") {
        state.transitions.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Jira request: ${init.method ?? "GET"} ${pathname}`);
    },
  };
}

async function startServer(jiraFetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jira-provider-test-"));
  const app = createTaskboardServer({ dataDirectory: directory, jiraFetch });
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

test("Jira preserves its public API behavior through the external-work provider", async () => {
  const jira = createJiraFixture();
  const baseUrl = await startServer(jira.fetch);

  const configured = await request(baseUrl, "/api/local/jira-connection", {
    method: "PUT",
    body: {
      baseUrl: "https://jira.example.test",
      username: "jira-user",
      password: "secret",
      projects: ["TASK"],
    },
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.connection.projectId, "jira-my-tasks");

  const providers = await request(baseUrl, "/api/external-work/providers");
  const jiraProvider = providers.body.providers.find((provider) => provider.id === "jira");
  assert.deepEqual(jiraProvider.supportedMutations, [
    "status",
    "title",
    "description",
    "priority",
    "labels",
    "dueDate",
  ]);
  assert.equal(jiraProvider.connection.baseUrl, "https://jira.example.test");

  const discovery = await request(baseUrl, "/api/external-work/providers/jira/projects");
  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.body.projects[0].id, "jira-my-tasks");
  assert.equal(discovery.body.projects[0].source, "jira");
  assert.equal(discovery.body.projects[0].externalUrl, "https://jira.example.test");

  const origin = createHash("sha256").update("jira-instance-1").digest("hex");
  const providerSync = await request(
    baseUrl,
    "/api/external-work/providers/jira/sync",
    { method: "POST" },
  );
  assert.equal(providerSync.response.status, 200);
  assert.equal(providerSync.body.projects[0].externalOrigin, origin);
  assert.equal(providerSync.body.projects[0].externalId, "jira-my-tasks");
  assert.equal(providerSync.body.projects[0].externalUrl, "https://jira.example.test");
  assert.equal(providerSync.body.tasks[0].externalKey, "TASK-7");

  const synced = await request(baseUrl, "/api/local/jira-connection/sync", { method: "POST" });
  assert.equal(synced.response.status, 200);
  const tasks = await request(baseUrl, "/api/tasks?projectId=jira-my-tasks");
  assert.equal(tasks.body.tasks.length, 1);
  const task = tasks.body.tasks[0];
  assert.equal(task.id, `JIRA:${origin.toUpperCase()}:10001`);
  assert.equal(task.identifier, task.id);
  assert.equal(task.source, "jira");
  assert.equal(task.externalOrigin, origin);
  assert.equal(task.externalId, "10001");
  assert.equal(task.externalKey, "TASK-7");
  assert.equal(task.externalUrl, "https://jira.example.test/browse/TASK-7");

  const updated = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: { version: task.version, title: "Updated Jira title" },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.task.title, "Updated Jira title");
  assert.deepEqual(jira.state.issueUpdates, [{ fields: { summary: "Updated Jira title" } }]);

  const moved = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/move`, {
    method: "POST",
    body: { version: updated.body.task.version, status: "in_progress", sortOrder: 1024 },
  });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.task.status, "in_progress");
  assert.deepEqual(jira.state.transitions, [{ transition: { id: "31" } }]);

  const fieldsUpdated = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: {
      version: moved.body.task.version,
      description: "Updated description",
      priority: "urgent",
      labels: ["updated-label"],
      dueDate: "2026-09-15",
    },
  });
  assert.equal(fieldsUpdated.response.status, 200);
  assert.deepEqual(jira.state.issueUpdates[1], {
    fields: {
      description: "Updated description",
      labels: ["updated-label"],
      duedate: "2026-09-15",
      priority: { id: "2" },
    },
  });

  const rejectedAssignee = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: {
      version: fieldsUpdated.body.task.version,
      assigneeTarget: "codex-agent",
    },
  });
  assert.equal(rejectedAssignee.response.status, 409);
  assert.equal(rejectedAssignee.body.error.code, "JIRA_ASSIGNEE_UNAVAILABLE");

  const rejectedProject = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: { version: fieldsUpdated.body.task.version, projectId: "local" },
  });
  assert.equal(rejectedProject.response.status, 409);
  assert.equal(rejectedProject.body.error.code, "JIRA_PROJECT_MOVE_UNAVAILABLE");

  const rejectedRecurrence = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: {
      version: fieldsUpdated.body.task.version,
      recurrence: { interval: 1, unit: "week" },
    },
  });
  assert.equal(rejectedRecurrence.response.status, 409);
  assert.equal(rejectedRecurrence.body.error.code, "EXTERNAL_MUTATION_UNSUPPORTED");

  const rejectedArchive = await request(
    baseUrl,
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    { method: "POST", body: { version: fieldsUpdated.body.task.version } },
  );
  assert.equal(rejectedArchive.response.status, 409);
  assert.equal(rejectedArchive.body.error.code, "JIRA_ARCHIVE_UNAVAILABLE");

  jira.state.issues = [];
  await request(baseUrl, "/api/local/jira-connection/sync", { method: "POST" });
  const archived = await request(baseUrl, "/api/tasks?projectId=jira-my-tasks&archived=true");
  assert.equal(archived.body.tasks.length, 1);
  assert.equal(archived.body.tasks[0].id, task.id);
  assert.notEqual(archived.body.tasks[0].archivedAt, null);

  const rejectedRestore = await request(
    baseUrl,
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    { method: "POST", body: { version: archived.body.tasks[0].version } },
  );
  assert.equal(rejectedRestore.response.status, 409);
  assert.equal(rejectedRestore.body.error.code, "JIRA_RESTORE_UNAVAILABLE");
});
