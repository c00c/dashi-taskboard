import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { createTaskboardCanvasService } from "./service.mjs";

let sessionRef = null;
const service = createTaskboardCanvasService({
  sessionSender: async (message) => {
    const events = [];
    let eventWindowIsClosed = false;
    let retainEventWindow = false;
    let closeEventWindow;
    const eventWindowClosed = new Promise((resolve) => {
      closeEventWindow = resolve;
    });
    const unsubscribe = sessionRef.on((event) => {
      if (
        event.type === "tool.execution_start"
        || event.type === "tool.execution_complete"
      ) {
        events.push(event);
      }
      if (event.type === "session.idle" || event.type === "session.error") {
        eventWindowIsClosed = true;
        closeEventWindow();
      }
    });
    try {
      await sessionRef.sendAndWait(message, 120_000);
      return events;
    } catch (error) {
      if (
        !eventWindowIsClosed
        && error instanceof Error
        && /^Timeout after \d+ms waiting for session\.idle$/.test(error.message)
      ) {
        retainEventWindow = true;
        error.copilotEventWindowClosed = eventWindowClosed;
      }
      throw error;
    } finally {
      if (eventWindowIsClosed || !retainEventWindow) {
        unsubscribe();
      } else {
        void eventWindowClosed.then(unsubscribe);
      }
    }
  },
  sessionId: process.env.SESSION_ID,
  workspacePath: () => sessionRef?.workspacePath,
});

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
sessionRef = session;
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
