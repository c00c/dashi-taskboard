import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskboardLanguageProvider } from "../i18n";
import type { ActorIdentity, DevelopmentScan, Task } from "../types";
import { TaskDetail } from "./TaskDetail";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listComments: vi.fn(async () => []),
    listTaskActivities: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    listExternalWorkActors: vi.fn(async () => [
      { type: "user", id: "unassigned", name: "Unassigned", avatarUrl: null },
      { type: "user", id: "ado-user", name: "ADO User", avatarUrl: null },
    ]),
    listExternalWorkProviders: vi.fn(async () => [
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
    ]),
  };
});

const currentUser: ActorIdentity = {
  type: "user",
  id: "current-user",
  name: "Current User",
  avatarUrl: null,
};

const developmentScan: DevelopmentScan = { workspacePath: null, contexts: [] };

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    identifier: "TB-1",
    projectId: "project-1",
    title: "Sample task",
    description: "Sample description",
    status: "todo",
    priority: "medium",
    labels: [],
    sortOrder: 1,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: "activity-1",
    activityUpdatedAt: "2026-01-01T00:00:00.000Z",
    creatorType: "user",
    creatorId: "current-user",
    creatorName: "Current User",
    creatorAvatarUrl: null,
    assignee: { type: "user", id: "unassigned", name: "Unassigned", avatarUrl: null },
    developmentContext: null,
    startDate: null,
    dueDate: null,
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

function renderDetail(task: Task) {
  return render(
    <TaskboardLanguageProvider language="en">
      <TaskDetail
        task={task}
        tasks={[task]}
        referenceTasks={[]}
        currentUser={currentUser}
        availableLabels={["bug"]}
        developmentScan={developmentScan}
        developmentScanLoading={false}
        commentsRevision={0}
        attachmentsRevision={0}
        onCreateLabel={async () => {}}
        onDeleteLabel={async () => {}}
        onUpdate={async (current) => current}
        onOpenTask={() => {}}
        onAddRelation={async (current) => ({ task: current, relatedTask: current })}
        onRemoveRelation={async (current) => ({ task: current, relatedTask: current })}
        onOpenThread={() => {}}
        onOpenLegacyLocalThread={() => {}}
        onOpenInThread={() => {}}
        onCopy={() => {}}
        openingThread={false}
        onError={() => {}}
      />
    </TaskboardLanguageProvider>,
  );
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

afterEach(cleanup);

describe("TaskDetail assignee options", () => {
  it("de-duplicates assignee options for external tasks", async () => {
    renderDetail(makeTask({ source: "ado", externalOrigin: "ado:example-org" }));

    await waitFor(() => expect(button("Assignee").disabled).toBe(false));
    fireEvent.click(button("Assignee"));

    const options = await screen.findAllByRole("option");
    const labels = options.map(
      (option) => option.querySelector(".task-property-option-label")?.textContent?.trim() ?? "",
    );
    expect(labels).toContain("Unassigned");
    expect(labels.filter((label) => label === "Unassigned")).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("TaskDetail external write set", () => {
  it("disables fields the provider does not accept and keeps local-only fields editable", async () => {
    renderDetail(makeTask({ source: "ado", externalOrigin: "ado:example-org" }));

    await waitFor(() => expect(button("Priority").disabled).toBe(true));
    expect((screen.getByLabelText("Issue title") as HTMLTextAreaElement).disabled).toBe(true);
    expect(button("Select or create labels").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit issue description" })).toBeNull();

    expect(button("Status").disabled).toBe(false);
    expect(button("Assignee").disabled).toBe(false);
    expect(button("Development context").disabled).toBe(false);

    const dateInputs = document.querySelectorAll<HTMLInputElement>("input[type=date]");
    expect(dateInputs.length).toBe(2);
    dateInputs.forEach((input) => expect(input.disabled).toBe(true));
    expect(button("Recurrence").disabled).toBe(true);
  });

  it("derives jira editability from the provider write set", async () => {
    renderDetail(makeTask({ source: "jira", externalOrigin: "jira:example" }));

    await waitFor(() => expect(button("Assignee").disabled).toBe(true));
    expect((screen.getByLabelText("Issue title") as HTMLTextAreaElement).disabled).toBe(false);
    expect(button("Priority").disabled).toBe(false);
    expect(button("Select or create labels").disabled).toBe(false);
    expect(button("Recurrence").disabled).toBe(false);
  });

  it("leaves purely local tasks fully editable", async () => {
    renderDetail(makeTask({ source: "local" }));

    await waitFor(() => expect(button("Priority").disabled).toBe(false));
    expect((screen.getByLabelText("Issue title") as HTMLTextAreaElement).disabled).toBe(false);
    expect(button("Assignee").disabled).toBe(false);
    expect(button("Select or create labels").disabled).toBe(false);
    expect(button("Recurrence").disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Edit issue description" })).toBeTruthy();

    const dateInputs = document.querySelectorAll<HTMLInputElement>("input[type=date]");
    expect(dateInputs.length).toBe(2);
    dateInputs.forEach((input) => expect(input.disabled).toBe(false));
  });
});
