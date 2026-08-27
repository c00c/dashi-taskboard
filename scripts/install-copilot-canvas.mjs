import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "copilot", "taskboard-canvas");
const destination = path.join(os.homedir(), ".copilot", "extensions", "taskboard");

await mkdir(path.dirname(destination), { recursive: true });

let destinationStat = null;
try {
  destinationStat = await lstat(destination);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (destinationStat) {
  const [installedSource, expectedSource] = await Promise.all([
    realpath(destination),
    realpath(source),
  ]);
  if (installedSource !== expectedSource) {
    throw new Error(
      `Cannot install Taskboard canvas because '${destination}' already exists and points elsewhere.`,
    );
  }
  console.log(`Taskboard canvas is already installed at ${destination}`);
} else {
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  console.log(`Installed Taskboard canvas at ${destination}`);
}

console.log("Reload Copilot extensions or start a new Copilot session to use the canvas.");
