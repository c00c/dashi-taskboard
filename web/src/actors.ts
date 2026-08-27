import type { ActorIdentity, AssigneeTarget } from "./types";

export const CODEX_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

export const UNASSIGNED_ACTOR: ActorIdentity = {
  type: "user",
  id: "unassigned",
  name: "Unassigned",
  avatarUrl: null,
};

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (target === "unassigned") return UNASSIGNED_ACTOR;
  return currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") return "codex-agent";
  if (actor.id === UNASSIGNED_ACTOR.id) return "unassigned";
  return actor.id === currentUser.id ? "current-user" : undefined;
}
