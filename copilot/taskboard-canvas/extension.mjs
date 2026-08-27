import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { createTaskboardCanvasService } from "./service.mjs";

let sessionRef = null;
const service = createTaskboardCanvasService({
  sessionSender: async (message) => {
    const events = [];
    let eventWindowIsClosed = false;
    let retainEventWindow = false;
    let terminalError = null;
    let closeEventWindow;
    const eventWindowClosed = new Promise((resolve) => {
      closeEventWindow = resolve;
    });
    const unsubscribe = sessionRef.on((event) => {
      if (
        event.type === "user.message"
        || event.type === "assistant.turn_start"
        || event.type === "tool.execution_start"
        || event.type === "tool.execution_complete"
      ) {
        events.push(event);
      }
      if (event.type === "session.idle" || event.type === "session.error") {
        if (event.type === "session.error") {
          terminalError = new Error(event.data.message);
          terminalError.stack = event.data.stack;
        }
        eventWindowIsClosed = true;
        closeEventWindow();
      }
    });
    let timeoutId;
    try {
      const messageId = await sessionRef.send(message);
      const timeout = 120_000;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timeout after ${timeout}ms waiting for session.idle`));
        }, timeout);
      });
      await Promise.race([eventWindowClosed, timeoutPromise]);
      if (terminalError) throw terminalError;
      return { events, messageId };
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
      if (timeoutId !== undefined) clearTimeout(timeoutId);
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
