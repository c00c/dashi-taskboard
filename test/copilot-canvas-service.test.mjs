import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardCanvasService } from "../copilot/taskboard-canvas/service.mjs";

const temporaryDirectories = [];
const services = [];

afterEach(async () => {
  while (services.length > 0) await services.pop().shutdown();
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function createService(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-canvas-test-"));
  const dataDirectory = path.join(root, "data");
  const staticDirectory = path.join(root, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(
    path.join(staticDirectory, "index.html"),
    "<!doctype html><title>Taskboard canvas fixture</title>",
  );
  temporaryDirectories.push(root);

  const taskboardOptions = { dataDirectory, staticDirectory };
  const service = createTaskboardCanvasService({ taskboardOptions, ...options });
  services.push(service);
  return { dataDirectory, service, taskboardOptions };
}

function controlledSessionSender(events, sent = []) {
  return async (message) => {
    sent.push(message);
    if (events instanceof Error) throw events;
    return events;
  };
}

function successfulToolEvents(toolName) {
  return [
    {
      type: "tool.execution_start",
      data: { toolCallId: "host-action-call", toolName },
    },
    {
      type: "tool.execution_complete",
      data: { toolCallId: "host-action-call", success: true },
    },
  ];
}

test("Copilot canvas creates a coding session with the task and workspace context", async () => {
  const sent = [];
  const { service } = await createService({
    sessionSender: controlledSessionSender(successfulToolEvents("create_session"), sent),
    sessionId: "active-copilot-session",
  });
  const opened = await service.open({ instanceId: "host-actions-panel" });

  const result = await request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body: {
      action: "create-session",
      task: {
        identifier: "TASK-42",
        title: "Add Copilot host actions",
        instruction: "Implement the settled ticket.",
        repository: "c00c/dashi-taskboard",
        workspacePath: "C:\\work\\dashi-taskboard",
      },
    },
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0].prompt, /TASK-42/);
  assert.match(sent[0].prompt, /Add Copilot host actions/);
  assert.match(sent[0].prompt, /Implement the settled ticket\./);
  assert.match(sent[0].prompt, /c00c\/dashi-taskboard/);
  assert.match(sent[0].prompt, /C:\\work\\dashi-taskboard/);
});

test("Copilot canvas jumps back to its active app session", async () => {
  const sent = [];
  const { service } = await createService({
    sessionSender: controlledSessionSender(successfulToolEvents("navigate_to"), sent),
    sessionId: "active-copilot-session",
  });
  const opened = await service.open({ instanceId: "jump-panel" });

  const result = await request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body: { action: "jump-to-session" },
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0].prompt, /navigate_to/);
  assert.match(sent[0].prompt, /active-copilot-session/);
});

test("Copilot canvas opens only HTTP and HTTPS external links through the host", async () => {
  const sent = [];
  const { service } = await createService({
    sessionSender: controlledSessionSender(successfulToolEvents("open_canvas"), sent),
  });
  const opened = await service.open({ instanceId: "external-link-panel" });

  const safe = await request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body: { action: "open-external", url: "https://example.com/review?id=42" },
  });
  const unsafe = await request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body: { action: "open-external", url: "javascript:alert(1)" },
  });

  assert.equal(safe.response.status, 200);
  assert.deepEqual(safe.body, { ok: true });
  assert.match(sent[0].prompt, /https:\/\/example\.com\/review\?id=42/);
  assert.equal(unsafe.response.status, 400);
  assert.equal(unsafe.body.error.code, "UNSAFE_EXTERNAL_URL");
  assert.equal(sent.length, 1);
});

test("Copilot host failures are returned to the canvas instead of looking successful", async () => {
  const { service } = await createService({
    sessionSender: controlledSessionSender(
      new Error("Copilot session sender rejected the request"),
    ),
  });
  const opened = await service.open({ instanceId: "failed-action-panel" });

  const result = await request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body: {
      action: "create-session",
      task: {
        identifier: "TASK-43",
        title: "Surface host failures",
        instruction: "Do not return a success-shaped fallback.",
        repository: "c00c/dashi-taskboard",
        workspacePath: "C:\\work\\dashi-taskboard",
      },
    },
  });

  assert.equal(result.response.status, 502);
  assert.deepEqual(result.body, {
    error: {
      code: "COPILOT_HOST_ACTION_FAILED",
      message: "Copilot session sender rejected the request",
    },
  });
});

for (const failure of [
  {
    name: "expected tool execution fails",
    events: [
      {
        type: "tool.execution_start",
        data: { toolCallId: "failed-call", toolName: "create_session" },
      },
      {
        type: "tool.execution_complete",
        data: {
          toolCallId: "failed-call",
          success: false,
          error: { message: "Session creation was rejected" },
        },
      },
    ],
  },
  {
    name: "expected tool execution is absent",
    events: [],
  },
  {
    name: "only the wrong tool executes",
    events: successfulToolEvents("navigate_to"),
  },
]) {
  test(`Copilot host action fails when ${failure.name}`, async () => {
    const { service } = await createService({
      sessionSender: controlledSessionSender(failure.events),
    });
    const opened = await service.open({ instanceId: `structured-failure-${failure.name}` });

    const result = await request(opened.url, "/api/copilot-host-actions", {
      method: "POST",
      body: {
        action: "create-session",
        task: {
          identifier: "TASK-44",
          title: "Require structured host completion",
          instruction: "Return success only after create_session succeeds.",
          repository: "c00c/dashi-taskboard",
          workspacePath: "C:\\work\\dashi-taskboard",
        },
      },
    });

    assert.equal(result.response.status, 502);
    assert.equal(result.body.error.code, "COPILOT_HOST_ACTION_FAILED");
  });
}

test("concurrent Copilot host actions use separate session event windows", async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const { service } = await createService({
    sessionSender: async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return successfulToolEvents("create_session");
    },
  });
  const opened = await service.open({ instanceId: "concurrent-host-actions" });
  const body = {
    action: "create-session",
    task: {
      identifier: "TASK-45",
      title: "Isolate host event windows",
      instruction: "Do not share one tool completion between requests.",
      repository: "c00c/dashi-taskboard",
      workspacePath: "C:\\work\\dashi-taskboard",
    },
  };

  const results = await Promise.all([
    request(opened.url, "/api/copilot-host-actions", { method: "POST", body }),
    request(opened.url, "/api/copilot-host-actions", { method: "POST", body }),
  ]);

  assert.deepEqual(results.map(({ response }) => response.status), [200, 200]);
  assert.equal(maximumInFlight, 1);
});

test("a timed-out host action retains its session event window until idle", async () => {
  let closeEventWindow;
  const eventWindowClosed = new Promise((resolve) => {
    closeEventWindow = resolve;
  });
  let calls = 0;
  const { service } = await createService({
    sessionSender: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("Timeout after 120000ms waiting for session.idle");
        error.copilotEventWindowClosed = eventWindowClosed;
        throw error;
      }
      return successfulToolEvents("create_session");
    },
  });
  const opened = await service.open({ instanceId: "timed-out-host-action" });
  const body = {
    action: "create-session",
    task: {
      identifier: "TASK-46",
      title: "Retain timed-out event window",
      instruction: "Do not let later requests consume stale tool events.",
      repository: "c00c/dashi-taskboard",
      workspacePath: "C:\\work\\dashi-taskboard",
    },
  };

  const first = await request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body,
  });
  assert.equal(first.response.status, 502);

  const secondRequest = request(opened.url, "/api/copilot-host-actions", {
    method: "POST",
    body,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);

  closeEventWindow();
  assert.equal((await secondRequest).response.status, 200);
  assert.equal(calls, 2);
});

test("Copilot host actions reject requests without the canvas capability", async () => {
  const { service } = await createService({
    sessionSender: () => assert.fail("unauthenticated requests must not reach Copilot"),
  });
  const opened = await service.open({ instanceId: "unauthenticated-panel" });

  const response = await fetch(new URL("/api/copilot-host-actions", opened.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "open-external", url: "https://example.com" }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "INVALID_COPILOT_HOST_TOKEN");
});

async function request(url, pathname, options = {}) {
  const headers = new Headers(options.headers);
  const hostToken = new URL(url).searchParams.get("hostToken");
  if (hostToken) headers.set("x-taskboard-copilot-token", hostToken);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(new URL(pathname, url), {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    response,
    body: response.status === 204 ? undefined : await response.json(),
  };
}

test("logical canvas panels share one working Taskboard URL", async () => {
  const { service } = await createService();

  const first = await service.open({ instanceId: "panel-one" });
  const second = await service.open({ instanceId: "panel-two" });

  assert.equal(first.url, second.url);
  assert.equal(new URL(first.url).searchParams.get("host"), "copilot");

  const response = await fetch(first.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Taskboard canvas fixture/);

  await service.close({ instanceId: "panel-one" });
  assert.equal((await fetch(second.url)).status, 200);
});

test("panel mutations are broadcast and survive panel and extension reopen", async () => {
  const { service, taskboardOptions } = await createService();
  const first = await service.open({ instanceId: "panel-one" });
  await service.open({ instanceId: "panel-two" });

  const eventResponse = await fetch(new URL("/api/events", first.url));
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  const created = await request(first.url, "/api/tasks", {
    method: "POST",
    body: { title: "Created from the first canvas panel" },
  });
  assert.equal(created.response.status, 201);
  const attachmentContents = "canvas attachment contents\n";
  const uploadResponse = await fetch(
    new URL(`/api/tasks/${created.body.task.id}/attachments`, first.url),
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "canvas-note.txt",
        "x-taskboard-attachment-kind": "attachment",
      },
      body: attachmentContents,
    },
  );
  assert.equal(uploadResponse.status, 201);
  const attachment = (await uploadResponse.json()).attachment;

  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    message += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(message, /event: task\.created/);
  assert.match(message, new RegExp(created.body.task.id));
  await reader.cancel();

  await service.close({ instanceId: "panel-one" });
  await service.close({ instanceId: "panel-two" });
  const reopened = await service.open({ instanceId: "panel-three" });
  const stillRunning = await request(reopened.url, `/api/tasks/${created.body.task.id}`);
  assert.equal(stillRunning.response.status, 200);

  await service.shutdown();
  const restartedService = createTaskboardCanvasService({ taskboardOptions });
  services.push(restartedService);
  const restarted = await restartedService.open({ instanceId: "panel-four" });
  const persisted = await request(restarted.url, `/api/tasks/${created.body.task.id}`);
  assert.equal(persisted.response.status, 200);
  assert.equal(persisted.body.task.title, "Created from the first canvas panel");
  const persistedAttachment = await fetch(
    new URL(`/api/attachments/${attachment.id}/content`, restarted.url),
  );
  assert.equal(persistedAttachment.status, 200);
  assert.equal(await persistedAttachment.text(), attachmentContents);
});

test("canvas opens with existing client, cloud, and Jira configuration", async () => {
  const { dataDirectory, service } = await createService();
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    path.join(dataDirectory, "client-storage.json"),
    JSON.stringify({ colorScheme: "dark", compactMode: true }),
  );
  await writeFile(
    path.join(dataDirectory, "cloud-companion.json"),
    JSON.stringify({
      version: 1,
      remoteUrl: "https://tasks.example.test",
      actorName: "Canvas user",
      sharedKey: "existing-shared-key",
      projectMappings: {},
    }),
  );
  await writeFile(
    path.join(dataDirectory, "jira-connection.json"),
    JSON.stringify({
      version: 1,
      baseUrl: "https://jira.example.test",
      username: "canvas-user",
      password: "existing-password",
      displayName: "Canvas user",
      projects: ["TASK"],
    }),
  );

  const opened = await service.open({ instanceId: "configured-panel" });
  const clientStorage = await request(opened.url, "/api/client-storage");
  assert.deepEqual(clientStorage.body.entries, {
    colorScheme: "dark",
    compactMode: true,
  });

  const cloud = await request(opened.url, "/api/local/cloud-session");
  assert.deepEqual(cloud.body, {
    mode: "cloud",
    remoteUrl: "https://tasks.example.test",
    actorName: "Canvas user",
    authenticated: true,
  });

  const jira = await request(opened.url, "/api/local/jira-connection");
  assert.equal(jira.body.connection.configured, true);
  assert.equal(jira.body.connection.baseUrl, "https://jira.example.test");
  assert.deepEqual(jira.body.connection.projects, ["TASK"]);
});
