import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${name} is required` };
  }
  return { value: value.trim() };
}

function hasExactKeys(value, expectedKeys) {
  return isDeepStrictEqual(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
  );
}

function normalizedToolArguments(toolName, toolArguments) {
  if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
    return null;
  }
  if (toolName === "navigate_to") {
    return hasExactKeys(toolArguments, ["id"]) && typeof toolArguments.id === "string"
      ? { id: toolArguments.id.trim() }
      : null;
  }
  if (toolName === "open_canvas") {
    if (
      !hasExactKeys(toolArguments, ["canvasId", "input", "instanceId"])
      || toolArguments.canvasId !== "browser"
      || typeof toolArguments.instanceId !== "string"
      || !toolArguments.input
      || typeof toolArguments.input !== "object"
      || Array.isArray(toolArguments.input)
      || !hasExactKeys(toolArguments.input, ["url"])
      || typeof toolArguments.input.url !== "string"
    ) {
      return null;
    }
    try {
      return {
        canvasId: "browser",
        input: { url: new URL(toolArguments.input.url).href },
        instanceId: toolArguments.instanceId.trim(),
      };
    } catch {
      return null;
    }
  }
  if (toolName === "create_session") {
    const kickoff = toolArguments.kickoff;
    if (
      !hasExactKeys(toolArguments, ["kickoff", "name", "workspace_type"])
      || typeof toolArguments.name !== "string"
      || toolArguments.workspace_type !== "worktree"
      || !kickoff
      || typeof kickoff !== "object"
      || Array.isArray(kickoff)
      || !hasExactKeys(kickoff, ["mode", "prompt"])
      || typeof kickoff.prompt !== "string"
      || kickoff.mode !== "autopilot"
    ) {
      return null;
    }
    return {
      kickoff: {
        mode: "autopilot",
        prompt: kickoff.prompt.trim(),
      },
      name: toolArguments.name.trim(),
      workspace_type: "worktree",
    };
  }
  return null;
}

function requireSuccessfulToolExecution(
  result,
  expectedToolName,
  expectedToolArguments,
) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const messageId = result?.messageId;
  const userMessage = events.find((event) => (
    event?.type === "user.message"
    && event.agentId === undefined
    && event.id === messageId
    && typeof event.data?.interactionId === "string"
    && event.data.interactionId.length > 0
  ));
  const matchingTurns = userMessage
    ? events.filter((event) => (
      event?.type === "assistant.turn_start"
      && event.agentId === undefined
      && event.data?.interactionId === userMessage.data.interactionId
      && typeof event.data.turnId === "string"
      && event.data.turnId.length > 0
    ))
    : [];
  if (matchingTurns.length !== 1) {
    throw new Error(
      `Copilot did not identify the exact turn for the expected ${expectedToolName} host action`,
    );
  }

  const expectedTurnId = matchingTurns[0].data.turnId;
  const starts = events.filter((event) => (
    event?.type === "tool.execution_start"
    && event.agentId === undefined
    && event.data?.turnId === expectedTurnId
  ));
  if (
    starts.length !== 1
    || starts[0].data?.toolName !== expectedToolName
    || typeof starts[0].data.toolCallId !== "string"
    || !isDeepStrictEqual(
      normalizedToolArguments(expectedToolName, starts[0].data.arguments),
      expectedToolArguments,
    )
  ) {
    throw new Error(
      `Copilot did not complete the expected ${expectedToolName} host action`,
    );
  }

  const completions = events.filter((event) => (
    event?.type === "tool.execution_complete"
    && event.agentId === undefined
    && event.data?.turnId === expectedTurnId
  ));
  if (
    completions.length !== 1
    || completions[0].data?.toolCallId !== starts[0].data.toolCallId
    || completions[0].data.success !== true
  ) {
    throw new Error(
      completions.length === 1
        ? completions[0].data?.error?.message
          || `Copilot did not complete the expected ${expectedToolName} host action`
        : `Copilot did not complete the expected ${expectedToolName} host action`,
    );
  }
}

export function createCopilotHostActions({ sessionSender, sessionId }) {
  if (typeof sessionSender !== "function") {
    throw new Error("A Copilot session sender is required");
  }
  let pendingHostAction = Promise.resolve();

  function sendExpectedHostAction(message, expectedToolName, expectedToolArguments) {
    const action = pendingHostAction.then(async () => {
      const result = await sessionSender(message);
      requireSuccessfulToolExecution(
        result,
        expectedToolName,
        expectedToolArguments,
      );
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
        const expectedArguments = { id: activeSessionId.trim() };
        await sendExpectedHostAction({
          prompt: `Call navigate_to exactly once with these arguments and do not call another tool: ${JSON.stringify(expectedArguments)}`,
        }, "navigate_to", expectedArguments);
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
        const expectedArguments = {
          canvasId: "browser",
          input: { url: url.href },
          instanceId: `taskboard-external-link-${randomUUID()}`,
        };
        await sendExpectedHostAction({
          prompt: `Call open_canvas exactly once with these arguments and do not call another tool: ${JSON.stringify(expectedArguments)}`,
        }, "open_canvas", expectedArguments);
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

    const sessionPrompt = [
      `Taskboard issue: ${values.identifier} - ${values.title}`,
      `Instruction: ${values.instruction}`,
      `Repository: ${values.repository}`,
      `Workspace context: ${values.workspacePath}`,
    ].join("\n");
    const expectedArguments = {
      kickoff: {
        mode: "autopilot",
        prompt: sessionPrompt,
      },
      name: values.title,
      workspace_type: "worktree",
    };
    const prompt = `Call create_session exactly once with these arguments and do not call another tool: ${JSON.stringify(expectedArguments)}`;
    try {
      await sendExpectedHostAction(
        { prompt },
        "create_session",
        expectedArguments,
      );
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
