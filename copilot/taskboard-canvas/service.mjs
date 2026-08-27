import { createTaskboardServer } from "../../server/index.mjs";

export function createTaskboardCanvasService({ taskboardOptions = {} } = {}) {
  const openPanels = new Set();
  let entry = null;
  let starting = null;

  async function start() {
    const app = createTaskboardServer(taskboardOptions);
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = new URL(`http://127.0.0.1:${address.port}/`);
      url.searchParams.set("host", "copilot");
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
