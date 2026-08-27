import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { createTaskboardCanvasService } from "./service.mjs";

const service = createTaskboardCanvasService();

const canvas = createCanvas({
  id: "taskboard",
  displayName: "Taskboard",
  description: "Open the existing local-first Taskboard and its persisted projects and tasks.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  open: (ctx) => service.open(ctx),
  onClose: (ctx) => service.close(ctx),
});

const session = await joinSession({ canvases: [canvas] });
await session.log("Taskboard canvas extension ready.", { ephemeral: true });

let shuttingDown = null;
function shutdown() {
  shuttingDown ??= service.shutdown();
  return shuttingDown;
}

function exitAfterShutdown() {
  shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error("Taskboard canvas shutdown failed:", error);
      process.exit(1);
    },
  );
}

process.once("SIGINT", exitAfterShutdown);
process.once("SIGTERM", exitAfterShutdown);
