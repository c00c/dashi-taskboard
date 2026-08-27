import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const runningApps = [];

const ADO_IDENTITIES_BY_STORAGE_KEY = {
  "33333333-3333-3333-3333-333333333333": {
    descriptor: "aad.next-user",
    displayName: "Next ADO User",
    uniqueName: "next@example.test",
  },
  "44444444-4444-4444-4444-444444444444": {
    descriptor: "aad.another-user",
    displayName: "Another ADO User",
    uniqueName: "another@example.test",
  },
};

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
    assignedTo: {
      id: "ado-user-id",
      displayName: "ADO User",
      uniqueName: "ado@example.test",
    },
    comments: [],
    mutationAccepted: false,
    patchFailure: null,
    failRefreshAfterMutation: false,
    commentFailure: false,
    paginateComments: false,
    graphFailure: false,
    requests: [],
  };

  return {
    state,
    async fetch(input, init = {}) {
      const url = new URL(input);
      state.requests.push({
        method: init.method ?? "GET",
        hostname: url.hostname,
        pathname: url.pathname,
        apiVersion: url.searchParams.get("api-version"),
        continuationToken: url.searchParams.get("continuationToken"),
        authorization: init.headers?.authorization,
        contentType: init.headers?.["content-type"],
        body: init.body ? JSON.parse(init.body) : null,
      });

      if (url.hostname === "vssps.dev.azure.com" && url.pathname === "/example-org/_apis/graph/users") {
        if (state.graphFailure) {
          return Response.json({ message: "graph unavailable" }, { status: 503 });
        }
        return Response.json({
          count: 2,
          value: [{
            descriptor: "aad.next-user",
            originId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            displayName: "Next ADO User",
            principalName: "next@example.test",
          }, {
            descriptor: "aad.another-user",
            originId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            displayName: "Another ADO User",
            principalName: "another@example.test",
          }],
        });
      }
      if (
        url.hostname === "vssps.dev.azure.com"
        && url.pathname === "/example-org/_apis/graph/storagekeys/aad.next-user"
      ) {
        return Response.json({ value: "33333333-3333-3333-3333-333333333333" });
      }
      if (
        url.hostname === "vssps.dev.azure.com"
        && url.pathname === "/example-org/_apis/graph/storagekeys/aad.another-user"
      ) {
        return Response.json({ value: "44444444-4444-4444-4444-444444444444" });
      }

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
        if (state.failRefreshAfterMutation && state.mutationAccepted) {
          return Response.json({ message: "refresh unavailable" }, { status: 503 });
        }
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
              ...(state.assignedTo ? { "System.AssignedTo": state.assignedTo } : {}),
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

      if (
        url.pathname === "/example-org/project-one/_apis/wit/workitems/42"
        && init.method === "PATCH"
      ) {
        if (state.patchFailure === "network") throw new Error("network unavailable");
        if (state.patchFailure === "auth") {
          return Response.json({ message: "unauthorized" }, { status: 401 });
        }
        if (state.patchFailure === "transition") {
          return Response.json({ message: "invalid transition" }, { status: 400 });
        }
        for (const operation of JSON.parse(init.body)) {
          if (operation.path === "/fields/System.State") state.remoteStatus = operation.value;
          if (operation.path === "/fields/System.AssignedTo" && operation.op === "remove") {
            state.assignedTo = null;
          }
          if (operation.path === "/fields/System.AssignedTo" && operation.op === "add") {
            state.assignedTo = {
              ...operation.value,
              ...ADO_IDENTITIES_BY_STORAGE_KEY[operation.value?.id],
            };
          }
        }
        state.mutationAccepted = true;
        return Response.json({ id: 42, rev: 8, fields: {} });
      }

      if (
        url.pathname === "/example-org/project-one/_apis/wit/workitems/42/comments"
        && init.method === "POST"
      ) {
        if (state.commentFailure) {
          return Response.json({ message: "comment rejected" }, { status: 400 });
        }
        const comment = {
          workItemId: 42,
          commentId: state.comments.length + 50,
          version: 1,
          text: JSON.parse(init.body).text,
          createdBy: {
            id: "comment-author-id",
            displayName: "ADO Commenter",
            uniqueName: "commenter@example.test",
          },
          createdDate: "2026-08-26T20:00:00.000Z",
          modifiedDate: "2026-08-26T20:00:00.000Z",
          isDeleted: false,
        };
        state.comments.push(comment);
        return Response.json(comment);
      }

      if (
        url.pathname === "/example-org/project-one/_apis/wit/workitems/42/comments"
        && (init.method ?? "GET") === "GET"
      ) {
        if (state.paginateComments && !url.searchParams.get("continuationToken")) {
          return Response.json(
            { count: 0, comments: [] },
            { headers: { "x-ms-continuationtoken": "next-page" } },
          );
        }
        return Response.json({ count: state.comments.length, comments: state.comments });
      }

      throw new Error(`Unexpected ADO request: ${init.method ?? "GET"} ${url.pathname}`);
    },
  };
}

function firstLanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ?? null;
}

async function startServer(adoFetch, listen = { port: 0, host: "127.0.0.1" }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-provider-test-"));
  const app = createTaskboardServer({ dataDirectory: directory, adoFetch });
  const address = await app.listen(listen);
  runningApps.push({ app, directory });
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
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

async function configureAndSync(baseUrl, overrides = {}) {
  const configured = await request(
    baseUrl,
    "/api/external-work/providers/ado/connection",
    { method: "PUT", body: configuration(os.tmpdir(), overrides) },
  );
  assert.equal(configured.response.status, 200);
  const synchronized = await request(
    baseUrl,
    "/api/external-work/providers/ado/sync",
    { method: "POST" },
  );
  assert.equal(synchronized.response.status, 200);
  return synchronized.body.tasks[0];
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

    const keptCredential = await request(
      baseUrl,
      "/api/external-work/providers/ado/connection",
      {
        method: "PUT",
        body: configuration(directory, { personalAccessToken: "" }),
      },
    );
    assert.equal(keptCredential.response.status, 200);
    assert.equal(JSON.stringify(keptCredential.body).includes("ado-secret"), false);

    const rediscoveredWithSavedCredential = await request(
      baseUrl,
      "/api/external-work/providers/ado/projects",
      {
        method: "POST",
        body: {
          organization: "example-org",
          personalAccessToken: "",
          projects: [{ id: "project-one", name: "Project One" }],
        },
      },
    );
    assert.equal(rediscoveredWithSavedCredential.response.status, 200);
    assert.equal(rediscoveredWithSavedCredential.body.projects[0].repository.name, "taskboard");
    assert.equal(JSON.stringify(rediscoveredWithSavedCredential.body).includes("ado-secret"), false);

    const providers = await request(baseUrl, "/api/external-work/providers");
    const provider = providers.body.providers.find((candidate) => candidate.id === "ado");
    assert.deepEqual(provider.supportedMutations, ["status", "assignee"]);
    assert.equal(provider.supportsComments, true);
    assert.equal(provider.connection.organization, "example-org");

    const actors = await request(baseUrl, "/api/external-work/providers/ado/actors");
    assert.equal(actors.response.status, 200);
    assert.deepEqual(actors.body.actors, [{
      type: "user",
      id: "ado:descriptor:aad.next-user",
      name: "Next ADO User",
      avatarUrl: null,
    }, {
      type: "user",
      id: "ado:descriptor:aad.another-user",
      name: "Another ADO User",
      avatarUrl: null,
    }]);
    assert.equal(
      ado.state.requests.filter((entry) => entry.pathname.includes("/_apis/graph/storagekeys/")).length,
      0,
    );
    ado.state.graphFailure = true;
    const failedActors = await request(baseUrl, "/api/external-work/providers/ado/actors");
    assert.equal(failedActors.response.status, 502);
    assert.equal(failedActors.body.error.code, "ADO_REQUEST_FAILED");
    ado.state.graphFailure = false;

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
        configuredProjectId: "project-one",
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

    const moved = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: {
        version: task.version,
        status: "in_review",
        developmentContext: { type: "branch", branch: "ado-local-work" },
      },
    });
    assert.equal(moved.response.status, 200);
    assert.equal(moved.body.task.status, "in_review");
    assert.deepEqual(moved.body.task.developmentContext, {
      type: "branch",
      branch: "ado-local-work",
    });

    const unassigned = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: { version: moved.body.task.version, assigneeTarget: "unassigned" },
    });
    assert.equal(unassigned.response.status, 200);
    assert.equal(unassigned.body.task.assignee.id, "unassigned");

    const assigned = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: {
        version: unassigned.body.task.version,
        title: unassigned.body.task.title,
        description: unassigned.body.task.description,
        status: unassigned.body.task.status,
        priority: unassigned.body.task.priority,
        labels: unassigned.body.task.labels,
        assignee: {
          type: "user",
          id: "ado:descriptor:aad.next-user",
          name: "Next ADO User",
          avatarUrl: null,
        },
        developmentContext: unassigned.body.task.developmentContext,
        startDate: unassigned.body.task.startDate,
        dueDate: unassigned.body.task.dueDate,
        recurrence: unassigned.body.task.recurrence,
      },
    });
    assert.equal(assigned.response.status, 200);
    assert.equal(
      assigned.body.task.assignee.id,
      "ado:descriptor:aad.next-user",
    );

    const rejectedRemoteField = await request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "PATCH",
        body: { version: assigned.body.task.version, title: "Must stay read-only" },
      },
    );
    assert.equal(rejectedRemoteField.response.status, 409);
    assert.equal(rejectedRemoteField.body.error.code, "EXTERNAL_MUTATION_UNSUPPORTED");

    const rejectedReorder = await request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}/move`,
      {
        method: "POST",
        body: {
          version: assigned.body.task.version,
          status: assigned.body.task.status,
          sortOrder: 2048,
        },
      },
    );
    assert.equal(rejectedReorder.response.status, 409);
    assert.equal(rejectedReorder.body.error.code, "EXTERNAL_MUTATION_UNSUPPORTED");

    ado.state.paginateComments = true;
    const commented = await request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}/comments`,
      { method: "POST", body: { body: "Remote-authoritative comment" } },
    );
    assert.equal(commented.response.status, 201, JSON.stringify(commented.body));
    assert.equal(commented.body.comment.id.includes(":comment:50"), true);
    assert.equal(commented.body.comment.body, "Remote-authoritative comment");
    assert.equal(commented.body.comment.authorName, "ADO Commenter");
    const visibleComments = await request(
      baseUrl,
      `/api/tasks/${encodeURIComponent(task.id)}/comments`,
    );
    assert.deepEqual(
      visibleComments.body.comments.map((comment) => comment.body),
      ["Remote-authoritative comment"],
    );

    const patches = ado.state.requests.filter((entry) => entry.method === "PATCH");
    assert.deepEqual(patches.map((entry) => entry.body), [
      [{ op: "add", path: "/fields/System.State", value: "Resolved" }],
      [{ op: "remove", path: "/fields/System.AssignedTo" }],
      [{
        op: "add",
        path: "/fields/System.AssignedTo",
        value: { id: "33333333-3333-3333-3333-333333333333" },
      }],
    ]);
    assert.equal(
      patches.every((entry) => entry.contentType === "application/json-patch+json"),
      true,
    );
    const commentCalls = ado.state.requests.filter(
      (entry) => entry.pathname.endsWith("/comments"),
    );
    assert.equal(commentCalls.some((entry) => entry.method === "POST"), true);
    assert.equal(
      commentCalls.some((entry) => entry.continuationToken === "next-page"),
      true,
    );
    assert.deepEqual(
      commentCalls.find((entry) => entry.method === "POST").body,
      { text: "Remote-authoritative comment" },
    );

    const event = await eventPromise;
    assert.equal(event.providerId, "ado");
    assert.deepEqual(event.projectIds, ["ado-11111111-1111-1111-1111-111111111111"]);
    assert.deepEqual(event.taskIds, [task.id]);

    const projects = await request(baseUrl, "/api/projects");
    const project = projects.body.projects.find((candidate) => candidate.source === "ado");
    assert.equal(project.workspacePath, directory);
    assert.equal(project.externalId, "11111111-1111-1111-1111-111111111111");

    const firstVersion = assigned.body.task.version;
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

    assert.equal(
      ado.state.requests
        .filter((entry) => entry.hostname !== "vssps.dev.azure.com")
        .every((entry) => entry.apiVersion === "7.1"),
      true,
    );
    assert.equal(
      ado.state.requests.every(
        (entry) => entry.authorization === `Basic ${Buffer.from(":ado-secret").toString("base64")}`,
      ),
      true,
    );
    const graph = ado.state.requests.find((entry) => entry.hostname === "vssps.dev.azure.com");
    assert.equal(graph.apiVersion, "7.1-preview.1");
    const storageKeyRequests = ado.state.requests.filter(
      (entry) => entry.pathname.includes("/_apis/graph/storagekeys/"),
    );
    assert.deepEqual(storageKeyRequests.map((entry) => entry.apiVersion), ["7.1"]);
    const batch = ado.state.requests.find(
      (entry) => entry.pathname.endsWith("/_apis/wit/workitemsbatch"),
    );
    assert.deepEqual(batch.body.ids, [42]);
    assert.equal(batch.body.ids.length <= 200, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ADO identifies one person the same way when read from a work item and when offered by discovery", async () => {
  const ado = createAdoFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-identity-"));
  const { baseUrl } = await startServer(ado.fetch);

  try {
    const task = await configureAndSync(baseUrl, {
      projects: configuration(directory).projects,
    });

    const actors = await request(baseUrl, "/api/external-work/providers/ado/actors");
    assert.equal(actors.response.status, 200);
    const nextUser = actors.body.actors.find((actor) => actor.name === "Next ADO User");
    assert.ok(nextUser);

    const assigned = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: { version: task.version, assignee: nextUser },
    });
    assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.task.assignee.id, nextUser.id);

    const pickerIds = new Set([
      ...actors.body.actors.map((actor) => actor.id),
      assigned.body.task.assignee.id,
    ]);
    assert.equal(pickerIds.size, actors.body.actors.length);

    const patchesAfterAssignment = ado.state.requests.filter(
      (entry) => entry.method === "PATCH",
    ).length;
    const reselected = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      body: { version: assigned.body.task.version, assignee: nextUser },
    });
    assert.equal(reselected.response.status, 200, JSON.stringify(reselected.body));
    assert.equal(reselected.body.task.assignee.id, nextUser.id);
    assert.equal(
      ado.state.requests.filter((entry) => entry.method === "PATCH").length,
      patchesAfterAssignment,
    );
    assert.equal(
      ado.state.requests.filter(
        (entry) => entry.pathname.includes("/_apis/graph/storagekeys/"),
      ).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider administration and credential-backed operations are device-local", async (t) => {
  const lanAddress = firstLanAddress();
  if (!lanAddress) {
    t.skip("No non-loopback IPv4 interface is available");
    return;
  }
  const ado = createAdoFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "ado-local-boundary-"));
  const { baseUrl, port } = await startServer(ado.fetch, { port: 0, host: "0.0.0.0" });
  const task = await configureAndSync(baseUrl, { projects: configuration(directory).projects });
  const lanBaseUrl = `http://${lanAddress}:${port}`;
  const requestsBeforeLan = ado.state.requests.length;
  const cases = [
    ["GET", "/api/external-work/providers"],
    ["PUT", "/api/external-work/providers/ado/connection", { organization: "attacker" }],
    ["GET", "/api/external-work/providers/ado/projects"],
    ["GET", "/api/external-work/providers/ado/actors"],
    ["POST", "/api/external-work/providers/ado/sync"],
    ["PATCH", `/api/tasks/${encodeURIComponent(task.id)}`, {
      version: task.version,
      status: "in_review",
    }],
    ["POST", `/api/tasks/${encodeURIComponent(task.id)}/move`, {
      version: task.version,
      status: "in_review",
    }],
    ["POST", `/api/tasks/${encodeURIComponent(task.id)}/comments`, {
      body: "Must remain local",
    }],
  ];

  try {
    for (const [method, pathname, body] of cases) {
      const result = await request(lanBaseUrl, pathname, {
        method,
        headers: { origin: lanBaseUrl },
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(result.response.status, 403, `${method} ${pathname}`);
      assert.equal(result.body.error.code, "LOCAL_ONLY", `${method} ${pathname}`);
    }
    assert.equal(ado.state.requests.length, requestsBeforeLan);

    const loopbackProviders = await request(baseUrl, "/api/external-work/providers");
    assert.equal(loopbackProviders.response.status, 200);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ADO synchronization recovers an accepted comment after local persistence fails", async () => {
  const ado = createAdoFixture();
  const { app, baseUrl } = await startServer(ado.fetch);
  const task = await configureAndSync(baseUrl);
  const createComment = app.database.createComment.bind(app.database);
  app.database.createComment = () => {
    throw new Error("controlled local persistence failure");
  };

  const failed = await request(
    baseUrl,
    `/api/tasks/${encodeURIComponent(task.id)}/comments`,
    { method: "POST", body: { body: "Accepted remotely once" } },
  );
  assert.equal(failed.response.status, 502);
  assert.equal(failed.body.error.code, "EXTERNAL_COMMENT_PERSIST_FAILED");
  assert.equal(ado.state.comments.length, 1);

  app.database.createComment = createComment;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const synchronized = await request(
      baseUrl,
      "/api/external-work/providers/ado/sync",
      { method: "POST" },
    );
    assert.equal(synchronized.response.status, 200);
  }
  const comments = await request(
    baseUrl,
    `/api/tasks/${encodeURIComponent(task.id)}/comments`,
  );
  assert.deepEqual(
    comments.body.comments.map((comment) => comment.body),
    ["Accepted remotely once"],
  );
  assert.equal(ado.state.comments.length, 1);
});

test("ADO repositories can be discovered from draft credentials without saving or returning the token", async () => {
  const ado = createAdoFixture();
  const { baseUrl, configPath } = await startServer(ado.fetch);

  const discovery = await request(
    baseUrl,
    "/api/external-work/providers/ado/projects",
    {
      method: "POST",
      body: {
        organization: "example-org",
        personalAccessToken: "draft-secret",
        projects: [{ id: "project-one", name: "Project One" }],
      },
    },
  );

  assert.equal(discovery.response.status, 200);
  assert.equal(discovery.body.projects[0].repository.name, "taskboard");
  assert.equal(JSON.stringify(discovery.body).includes("draft-secret"), false);
  await assert.rejects(readFile(configPath, "utf8"), { code: "ENOENT" });

  const providers = await request(baseUrl, "/api/external-work/providers");
  assert.equal(
    providers.body.providers.find((candidate) => candidate.id === "ado").connection.configured,
    false,
  );
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

test("ADO write failures remain explicit and never create success-shaped local state", async () => {
  const cases = [
    ["auth", "ADO_AUTH_FAILED"],
    ["transition", "ADO_REQUEST_FAILED"],
    ["network", "ADO_MUTATION_INDETERMINATE"],
  ];
  for (const [failure, expectedCode] of cases) {
    const ado = createAdoFixture();
    const { baseUrl } = await startServer(ado.fetch);
    const task = await configureAndSync(baseUrl);
    ado.state.patchFailure = failure;
    const failed = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/move`, {
      method: "POST",
      body: { version: task.version, status: "in_review" },
    });
    assert.equal(failed.response.status >= 400, true);
    assert.equal(failed.body.error.code, expectedCode);
    const unchanged = await request(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}`);
    assert.equal(unchanged.body.task.status, "in_progress");
  }

  const ambiguous = createAdoFixture();
  const { baseUrl: ambiguousBaseUrl } = await startServer(ambiguous.fetch);
  const ambiguousTask = await configureAndSync(ambiguousBaseUrl, {
    stateMapping: {
      New: "todo",
      Active: "in_progress",
      Resolved: "in_review",
      "Ready for review": "in_review",
      Closed: "done",
    },
  });
  const rejectedMapping = await request(
    ambiguousBaseUrl,
    `/api/tasks/${encodeURIComponent(ambiguousTask.id)}/move`,
    {
      method: "POST",
      body: { version: ambiguousTask.version, status: "in_review" },
    },
  );
  assert.equal(rejectedMapping.response.status, 409);
  assert.equal(rejectedMapping.body.error.code, "ADO_STATE_MAPPING_AMBIGUOUS");
  assert.equal(ambiguous.state.requests.some((entry) => entry.method === "PATCH"), false);

  const refresh = createAdoFixture();
  const { baseUrl: refreshBaseUrl } = await startServer(refresh.fetch);
  const refreshTask = await configureAndSync(refreshBaseUrl);
  refresh.state.failRefreshAfterMutation = true;
  const indeterminate = await request(
    refreshBaseUrl,
    `/api/tasks/${encodeURIComponent(refreshTask.id)}`,
    {
      method: "PATCH",
      body: {
        version: refreshTask.version,
        status: "in_review",
        developmentContext: { type: "branch", branch: "must-not-persist" },
      },
    },
  );
  assert.equal(indeterminate.response.status, 502);
  assert.equal(indeterminate.body.error.code, "ADO_REFRESH_FAILED");
  const locallyUnchanged = await request(
    refreshBaseUrl,
    `/api/tasks/${encodeURIComponent(refreshTask.id)}`,
  );
  assert.equal(locallyUnchanged.body.task.status, "in_progress");
  assert.equal(locallyUnchanged.body.task.developmentContext, null);
  assert.equal(refresh.state.remoteStatus, "Resolved");

  const comments = createAdoFixture();
  const { baseUrl: commentsBaseUrl } = await startServer(comments.fetch);
  const commentTask = await configureAndSync(commentsBaseUrl);
  comments.state.commentFailure = true;
  const failedComment = await request(
    commentsBaseUrl,
    `/api/tasks/${encodeURIComponent(commentTask.id)}/comments`,
    { method: "POST", body: { body: "Must not appear locally" } },
  );
  assert.equal(failedComment.response.status, 409);
  assert.equal(failedComment.body.error.code, "ADO_REQUEST_FAILED");
  const localComments = await request(
    commentsBaseUrl,
    `/api/tasks/${encodeURIComponent(commentTask.id)}/comments`,
  );
  assert.deepEqual(localComments.body.comments, []);
});
