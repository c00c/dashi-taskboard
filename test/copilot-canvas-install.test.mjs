import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test("user-scoped install resolves the complete canvas runtime from an unrelated project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-canvas-install-"));
  const unrelatedProject = path.join(root, "unrelated-project");
  const dataDirectory = path.join(root, "existing-data");
  await mkdir(unrelatedProject, { recursive: true });
  temporaryDirectories.push(root);

  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    CODEX_TASKBOARD_DATA_DIR: dataDirectory,
  };
  const installed = await execFileAsync(
    "npm",
    ["--prefix", projectRoot, "run", "copilot:install-canvas"],
    {
      cwd: unrelatedProject,
      env: environment,
      shell: process.platform === "win32",
    },
  );

  const installedExtension = path.join(root, ".copilot", "extensions", "taskboard");
  assert.equal(
    await realpath(installedExtension),
    await realpath(path.join(projectRoot, "copilot", "taskboard-canvas")),
  );

  assert.match(installed.stdout, /Verified Taskboard canvas at http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(installed.stdout, /host=copilot/);
});

test("user-scoped install repoints a Taskboard link from another checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-canvas-relocation-"));
  const unrelatedProject = path.join(root, "unrelated-project");
  const previousSource = path.join(root, "previous-checkout", "copilot", "taskboard-canvas");
  const installedExtension = path.join(root, ".copilot", "extensions", "taskboard");
  await mkdir(unrelatedProject, { recursive: true });
  await mkdir(previousSource, { recursive: true });
  await mkdir(path.dirname(installedExtension), { recursive: true });
  await symlink(
    previousSource,
    installedExtension,
    process.platform === "win32" ? "junction" : "dir",
  );
  temporaryDirectories.push(root);

  const installed = await execFileAsync(
    "npm",
    ["--prefix", projectRoot, "run", "copilot:install-canvas"],
    {
      cwd: unrelatedProject,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODEX_TASKBOARD_DATA_DIR: path.join(root, "existing-data"),
      },
      shell: process.platform === "win32",
    },
  );

  assert.equal(
    await realpath(installedExtension),
    await realpath(path.join(projectRoot, "copilot", "taskboard-canvas")),
  );
  assert.match(installed.stdout, /Verified Taskboard canvas at http:\/\/127\.0\.0\.1:\d+\//);
});

test("user-scoped install recovers a broken Taskboard link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-canvas-broken-link-"));
  const unrelatedProject = path.join(root, "unrelated-project");
  const installedExtension = path.join(root, ".copilot", "extensions", "taskboard");
  await mkdir(unrelatedProject, { recursive: true });
  await mkdir(path.dirname(installedExtension), { recursive: true });
  await symlink(
    path.join(root, "missing-checkout", "copilot", "taskboard-canvas"),
    installedExtension,
    process.platform === "win32" ? "junction" : "dir",
  );
  temporaryDirectories.push(root);

  const installed = await execFileAsync(
    "npm",
    ["--prefix", projectRoot, "run", "copilot:install-canvas"],
    {
      cwd: unrelatedProject,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODEX_TASKBOARD_DATA_DIR: path.join(root, "existing-data"),
      },
      shell: process.platform === "win32",
    },
  );

  assert.equal(
    await realpath(installedExtension),
    await realpath(path.join(projectRoot, "copilot", "taskboard-canvas")),
  );
  assert.match(installed.stdout, /Verified Taskboard canvas at http:\/\/127\.0\.0\.1:\d+\//);
});

test("user-scoped install refuses to replace a real extension directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-canvas-real-directory-"));
  const unrelatedProject = path.join(root, "unrelated-project");
  const installedExtension = path.join(root, ".copilot", "extensions", "taskboard");
  await mkdir(unrelatedProject, { recursive: true });
  await mkdir(installedExtension, { recursive: true });
  temporaryDirectories.push(root);

  await assert.rejects(
    execFileAsync(
      "npm",
      ["--prefix", projectRoot, "run", "copilot:install-canvas"],
      {
        cwd: unrelatedProject,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          CODEX_TASKBOARD_DATA_DIR: path.join(root, "existing-data"),
        },
        shell: process.platform === "win32",
      },
    ),
    /already exists and is not a link/,
  );
});
