function requiredText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${name} is required` };
  }
  return { value: value.trim() };
}

function requireSuccessfulToolExecution(events, expectedToolName) {
  const startedCalls = new Set();
  let failure;

  for (const event of Array.isArray(events) ? events : []) {
    if (
      event?.type === "tool.execution_start"
      && event.data?.toolName === expectedToolName
      && typeof event.data.toolCallId === "string"
    ) {
      startedCalls.add(event.data.toolCallId);
      continue;
    }
    if (
      event?.type !== "tool.execution_complete"
      || !startedCalls.has(event.data?.toolCallId)
    ) {
      continue;
    }
    if (event.data.success === true) return;
    failure = event.data.error?.message;
  }

  throw new Error(
    failure
      || `Copilot did not complete the expected ${expectedToolName} host action`,
  );
}

export function createCopilotHostActions({ sessionSender, sessionId }) {
  if (typeof sessionSender !== "function") {
    throw new Error("A Copilot session sender is required");
  }
  let pendingHostAction = Promise.resolve();

  function sendExpectedHostAction(message, expectedToolName) {
    const action = pendingHostAction.then(async () => {
      const events = await sessionSender(message);
      requireSuccessfulToolExecution(events, expectedToolName);
    });
    pendingHostAction = action.catch((error) => error?.copilotEventWindowClosed);
    return action;
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
        await sendExpectedHostAction({
          prompt: `Use the navigate_to host API to navigate the user to the active Copilot app session '${activeSessionId}'.`,
        }, "navigate_to");
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
        await sendExpectedHostAction({
          prompt: `Open this safe external URL for the user in the browser canvas using the open_canvas host API with canvasId 'browser': ${url.href}`,
        }, "open_canvas");
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
      await sendExpectedHostAction({ prompt }, "create_session");
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
