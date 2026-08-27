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

async function createService() {
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
  const service = createTaskboardCanvasService({ taskboardOptions });
  services.push(service);
  return { dataDirectory, service, taskboardOptions };
}

async function request(url, pathname, options = {}) {
  const headers = new Headers(options.headers);
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
