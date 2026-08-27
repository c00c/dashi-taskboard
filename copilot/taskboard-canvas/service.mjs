import { randomBytes, timingSafeEqual } from "node:crypto";

import { createTaskboardServer } from "../../server/index.mjs";
import { createCopilotHostActions } from "./host-actions.mjs";

export function createTaskboardCanvasService({
  taskboardOptions = {},
  sessionSender = async () => {
    throw new Error("Copilot session is unavailable");
  },
  sessionId,
  workspacePath,
} = {}) {
  const openPanels = new Set();
  const hostToken = randomBytes(32).toString("hex");
  const hostActions = createCopilotHostActions({ sessionSender, sessionId });
  let entry = null;
  let starting = null;

  async function start() {
    const app = createTaskboardServer({
      ...taskboardOptions,
      hostActionHandler: async (request, input) => {
        const providedToken = request.headers["x-taskboard-copilot-token"];
        const authenticated = typeof providedToken === "string"
          && providedToken.length === hostToken.length
          && timingSafeEqual(Buffer.from(providedToken), Buffer.from(hostToken));
        if (!authenticated) {
          return {
            status: 401,
            body: {
              error: {
                code: "INVALID_COPILOT_HOST_TOKEN",
                message: "Copilot host authentication is required",
              },
            },
          };
        }
        return hostActions(input);
      },
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = new URL(`http://127.0.0.1:${address.port}/`);
      url.searchParams.set("host", "copilot");
      url.searchParams.set("hostToken", hostToken);
      const activeWorkspacePath = typeof workspacePath === "function" ? workspacePath() : workspacePath;
      if (activeWorkspacePath) url.searchParams.set("workspacePath", activeWorkspacePath);
      return { app, url: url.href };
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  async function runningEntry() {
    if (entry) return entry;
    starting ??= start();
    try {
      entry = await starting;
      return entry;
    } finally {
      starting = null;
    }
  }

  return {
    async open({ instanceId }) {
      const current = await runningEntry();
      openPanels.add(instanceId);
      return { title: "Taskboard", url: current.url };
    },
    async close({ instanceId }) {
      openPanels.delete(instanceId);
    },
    async shutdown() {
      const current = entry ?? (starting ? await starting : null);
      entry = null;
      starting = null;
      openPanels.clear();
      if (current) await current.app.close();
    },
  };
}
