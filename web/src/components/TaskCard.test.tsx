import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ExternalWorkProviderDescription } from "../api";
import { TaskboardLanguageProvider } from "../i18n";
import type { TaskCardPresentation } from "../taskConversations";
import type { ActorIdentity, Task } from "../types";
import { TaskCard } from "./TaskCard";

const providers: ExternalWorkProviderDescription[] = [
  {
    id: "ado",
    displayName: "Azure DevOps",
    connection: { configured: true },
    supportedMutations: ["status", "assignee"],
    localOnlyMutations: ["developmentContext"],
  },
  {
    id: "jira",
    displayName: "Jira",
    connection: { configured: true },
    supportedMutations: ["status", "title", "description", "priority", "labels", "dueDate"],
    localOnlyMutations: ["developmentContext", "startDate", "recurrence"],
  },
];

const currentUser: ActorIdentity = {
  type: "user",
  id: "current-user",
  name: "Current User",
  avatarUrl: null,
};

const unassigned: ActorIdentity = {
  type: "user",
  id: "unassigned",
  name: "Unassigned",
  avatarUrl: null,
};

const presentation: TaskCardPresentation = {
  conversations: [],
  processing: { running: false, completed: null, total: null, startedAt: null },
  unread: false,
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    identifier: "TB-1",
    projectId: "project-1",
    title: "Sample task",
    description: "Sample description",
    status: "todo",
    priority: "medium",
    labels: ["bug"],
    sortOrder: 1,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [unassigned],
    previewImage: null,
    activityKey: "activity-1",
    activityUpdatedAt: "2026-01-01T00:00:00.000Z",
    creatorType: "user",
    creatorId: "current-user",
    creatorName: "Current User",
    creatorAvatarUrl: null,
    assignee: unassigned,
    developmentContext: null,
    startDate: null,
    dueDate: "2026-02-01",
    recurrence: null,
    source: "local",
    externalOrigin: null,
    externalKey: null,
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderCards(tasks: Task[]) {
  return render(
    <TaskboardLanguageProvider language="en">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          presentation={presentation}
          now={Date.parse("2026-01-02T00:00:00.000Z")}
          isDragging={false}
          dragShift={0}
          isMoving={false}
          isSettling={false}
          isContextMenuOpen={false}
          availableLabels={["bug"]}
          externalProviders={providers}
          currentUser={currentUser}
          showCover={false}
          showBody={false}
          onCreateLabel={async () => {}}
          onEdit={() => {}}
          onUpdate={async (current) => current}
          onContextMenu={() => {}}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onOpenConversation={() => {}}
        />
      ))}
    </TaskboardLanguageProvider>,
  );
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function dueDateInput(name: string): HTMLInputElement {
  return screen.getByLabelText(name) as HTMLInputElement;
}

afterEach(cleanup);

describe("TaskCard assignee options", () => {
  it("de-duplicates assignee options for an unassigned external task", () => {
    renderCards([makeTask({ source: "ado", externalOrigin: "ado:example-org" })]);

    fireEvent.click(button("TB-1 assignee"));

    const labels = screen.getAllByRole("option").map(
      (option) => option.querySelector(".task-property-option-label")?.textContent?.trim() ?? "",
    );
    expect(labels).toContain("Unassigned");
    expect(labels.filter((label) => label === "Unassigned")).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("TaskCard external write set", () => {
  it("blocks quick edits azure devops does not accept and keeps assignee editable", () => {
    renderCards([makeTask({ source: "ado", externalOrigin: "ado:example-org" })]);

    expect(button("TB-1 priority").disabled).toBe(true);
    expect(button("Select or create labels").disabled).toBe(true);
    expect(dueDateInput("TB-1 due date").disabled).toBe(true);
    expect(button("TB-1 assignee").disabled).toBe(false);
  });

  it("allows quick edits jira accepts and blocks assignee", () => {
    renderCards([makeTask({ source: "jira", externalOrigin: "jira:example" })]);

    expect(button("TB-1 priority").disabled).toBe(false);
    expect(button("Select or create labels").disabled).toBe(false);
    expect(dueDateInput("TB-1 due date").disabled).toBe(false);
    expect(button("TB-1 assignee").disabled).toBe(true);
  });

  it("leaves local tasks fully editable", () => {
    renderCards([makeTask({ source: "local" })]);

    expect(button("TB-1 priority").disabled).toBe(false);
    expect(button("Select or create labels").disabled).toBe(false);
    expect(dueDateInput("TB-1 due date").disabled).toBe(false);
    expect(button("TB-1 assignee").disabled).toBe(false);
  });

  it("evaluates each card against its own provider", () => {
    renderCards([
      makeTask({ id: "task-jira", identifier: "TB-9", source: "jira", externalOrigin: "jira:example" }),
      makeTask({ id: "task-ado", identifier: "TB-8", source: "ado", externalOrigin: "ado:example-org" }),
    ]);

    expect(button("TB-9 priority").disabled).toBe(false);
    expect(button("TB-9 assignee").disabled).toBe(true);
    expect(button("TB-8 priority").disabled).toBe(true);
    expect(button("TB-8 assignee").disabled).toBe(false);
  });
});
