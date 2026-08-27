function requiredText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${name} is required` };
  }
  return { value: value.trim() };
}

export function createCopilotHostActions({ sessionSender, sessionId }) {
  if (typeof sessionSender !== "function") {
    throw new Error("A Copilot session sender is required");
  }

  return async function handleHostAction(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        status: 400,
        body: { error: { code: "INVALID_HOST_ACTION", message: "Host action must be an object" } },
      };
    }

    if (input.action === "jump-to-session") {
      const activeSessionId = typeof sessionId === "function" ? sessionId() : sessionId;
      if (typeof activeSessionId !== "string" || activeSessionId.trim().length === 0) {
        return {
          status: 409,
          body: {
            error: {
              code: "COPILOT_SESSION_UNAVAILABLE",
              message: "The Copilot app session may have closed",
            },
          },
        };
      }
      try {
        await sessionSender({
          prompt: `Use the navigate_to host API to navigate the user to the active Copilot app session '${activeSessionId}'.`,
        });
        return { status: 200, body: { ok: true } };
      } catch {
        return {
          status: 409,
          body: {
            error: {
              code: "COPILOT_SESSION_UNAVAILABLE",
              message: "The Copilot app session may have closed",
            },
          },
        };
      }
    }

    if (input.action === "open-external") {
      let url;
      try {
        url = new URL(input.url);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
        return {
          status: 400,
          body: {
            error: {
              code: "UNSAFE_EXTERNAL_URL",
              message: "External links must use HTTP or HTTPS",
            },
          },
        };
      }
      try {
        await sessionSender({
          prompt: `Open this safe external URL for the user with the Copilot host browser API: ${url.href}`,
        });
        return { status: 200, body: { ok: true } };
      } catch (error) {
        return {
          status: 502,
          body: {
            error: {
              code: "COPILOT_HOST_ACTION_FAILED",
              message: error instanceof Error ? error.message : "Copilot could not open the external link",
            },
          },
        };
      }
    }

    if (input.action !== "create-session") {
      return {
        status: 400,
        body: { error: { code: "UNSUPPORTED_HOST_ACTION", message: "Unsupported Copilot host action" } },
      };
    }

    const task = input.task;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      return {
        status: 400,
        body: { error: { code: "INVALID_HOST_ACTION", message: "Task context is required" } },
      };
    }
    const fields = ["identifier", "title", "instruction", "repository", "workspacePath"];
    const values = {};
    for (const field of fields) {
      const parsed = requiredText(task[field], `task.${field}`);
      if (parsed.error) {
        return {
          status: 400,
          body: { error: { code: "INVALID_HOST_ACTION", message: parsed.error } },
        };
      }
      values[field] = parsed.value;
    }

    const prompt = [
      "Create a coding session for this Taskboard issue using the create_session host API.",
      `Identifier: ${values.identifier}`,
      `Title: ${values.title}`,
      `Instruction: ${values.instruction}`,
      `Repository: ${values.repository}`,
      `Workspace: ${values.workspacePath}`,
      "Start the new session with the instruction above and preserve this repository and workspace context.",
    ].join("\n");

    try {
      await sessionSender({ prompt });
      return { status: 200, body: { ok: true } };
    } catch (error) {
      return {
        status: 502,
        body: {
          error: {
            code: "COPILOT_HOST_ACTION_FAILED",
            message: error instanceof Error ? error.message : "Copilot could not create the coding session",
          },
        },
      };
    }
  };
}
