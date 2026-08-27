import { access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionDirectory = path.join(os.homedir(), ".copilot", "extensions", "taskboard");
const installedSource = await realpath(extensionDirectory);
const repositoryRoot = path.resolve(installedSource, "..", "..");

await Promise.all([
  access(path.join(installedSource, "extension.mjs")),
  access(path.join(installedSource, "service.mjs")),
  access(path.join(installedSource, "host-actions.mjs")),
  access(path.join(repositoryRoot, "server", "index.mjs")),
  access(path.join(repositoryRoot, "dist", "web", "index.html")),
  access(path.join(repositoryRoot, "package.json")),
]);

const { createTaskboardCanvasService } = await import(
  pathToFileURL(path.join(extensionDirectory, "service.mjs")).href
);
const service = createTaskboardCanvasService();

try {
  const first = await service.open({ instanceId: "install-verification" });
  const firstUrl = new URL(first.url);
  if (firstUrl.searchParams.get("host") !== "copilot") {
    throw new Error("Installed canvas URL does not identify the Copilot host");
  }
  const [webResponse, dataResponse] = await Promise.all([
    fetch(firstUrl),
    fetch(new URL("/api/projects", firstUrl)),
  ]);
  if (!webResponse.ok || !dataResponse.ok) {
    throw new Error(
      `Installed canvas runtime failed: web=${webResponse.status}, data=${dataResponse.status}`,
    );
  }

  await service.close({ instanceId: "install-verification" });
  const reopened = await service.open({ instanceId: "install-verification-reopened" });
  if (!(await fetch(reopened.url)).ok) {
    throw new Error("Installed canvas did not reopen successfully");
  }

  firstUrl.searchParams.delete("hostToken");
  console.log(`Verified Taskboard canvas at ${firstUrl.href}`);
  console.log(`Runtime source: ${repositoryRoot}`);
} finally {
  await service.shutdown();
}
