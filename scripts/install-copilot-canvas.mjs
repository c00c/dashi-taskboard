import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
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
  if (!destinationStat.isSymbolicLink()) {
    throw new Error(
      `Cannot install Taskboard canvas because '${destination}' already exists and is not a link.`,
    );
  }

  const expectedSource = await realpath(source);
  let installedSource = null;
  try {
    installedSource = await realpath(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (installedSource === expectedSource) {
    console.log(`Taskboard canvas is already installed at ${destination}`);
  } else {
    const replacement = `${destination}.replacement-${randomUUID()}`;
    try {
      await symlink(source, replacement, process.platform === "win32" ? "junction" : "dir");
      if (process.platform === "win32") {
        const previous = `${destination}.previous-${randomUUID()}`;
        await rename(destination, previous);
        try {
          await rename(replacement, destination);
        } catch (error) {
          await rename(previous, destination);
          throw error;
        }
        await rm(previous, { force: true });
      } else {
        await rename(replacement, destination);
      }
    } finally {
      await rm(replacement, { force: true });
    }
    console.log(`Repointed Taskboard canvas at ${destination}`);
  }
} else {
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  console.log(`Installed Taskboard canvas at ${destination}`);
}

console.log("Reload Copilot extensions or start a new Copilot session to use the canvas.");
