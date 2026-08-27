import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskboardLanguageProvider } from "../i18n";
import type { AdoConnection, AdoDiscoveredProject } from "../types";
import { AdoConnectionDialog } from "./AdoConnectionDialog";

const repository: AdoDiscoveredProject = {
  id: "ado-repository-1",
  name: "Project One · taskboard",
  labels: ["ado"],
  workspacePath: null,
  repository: {
    id: "repository-1",
    name: "taskboard",
    configuredProjectId: "project-one",
    projectId: "project-guid",
    projectName: "Project One",
  },
  externalOrigin: "ado:example-org",
  externalId: "repository-1",
  externalUrl: "https://dev.azure.com/example-org/project-one/_git/taskboard",
  source: "ado",
};

afterEach(cleanup);

function Harness({
  connection,
  onSave,
}: {
  connection: AdoConnection;
  onSave: (input: unknown) => Promise<void>;
}) {
  const [repositories, setRepositories] = useState<AdoDiscoveredProject[]>([]);
  return (
    <TaskboardLanguageProvider language="en">
      <AdoConnectionDialog
        connection={connection}
        repositories={repositories}
        busy={false}
        error={null}
        status={null}
        onClose={() => {}}
        onDiscover={async (input) => {
          expect(input).toEqual({
            organization: "example-org",
            personalAccessToken: "draft-secret",
            projects: [{ id: "project-one", name: "Project One" }],
          });
          setRepositories([repository]);
        }}
        onSave={onSave}
        onSync={async () => {}}
      />
    </TaskboardLanguageProvider>
  );
}

describe("AdoConnectionDialog", () => {
  it("discovers repositories, maps selected work, and submits explicit lifecycle mappings", async () => {
    const onSave = vi.fn(async () => {});
    render(<Harness
      connection={{
        configured: false,
        organization: null,
        projects: [],
        stateMapping: {},
      }}
      onSave={onSave}
    />);

    fireEvent.change(screen.getByLabelText("Organization"), { target: { value: "example-org" } });
    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "draft-secret" } });
    fireEvent.change(screen.getByLabelText("Projects"), { target: { value: "project-one | Project One" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover repositories" }));

    const selected = await screen.findByRole("checkbox", { name: "Project One · taskboard" });
    fireEvent.click(selected);
    fireEvent.change(screen.getByLabelText("Local workspace for Project One · taskboard"), {
      target: { value: "C:\\work\\taskboard" },
    });
    fireEvent.change(screen.getByLabelText("Work item IDs for Project One · taskboard"), {
      target: { value: "42, 84" },
    });
    fireEvent.change(screen.getByLabelText("State mappings"), {
      target: { value: "New = todo\nActive = in_progress\nClosed = done" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and sync" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      organization: "example-org",
      personalAccessToken: "draft-secret",
      projects: [{
        id: "project-one",
        name: "Project One",
        repositories: [{
          id: "repository-1",
          workspacePath: "C:\\work\\taskboard",
          workItemIds: [42, 84],
        }],
      }],
      stateMapping: {
        New: "todo",
        Active: "in_progress",
        Closed: "done",
      },
    }));
  });

  it("never displays a saved token and allows a blank token for the same organization", () => {
    render(<Harness
      connection={{
        configured: true,
        organization: "example-org",
        projects: [{ id: "project-one", name: "Project One", repositories: [] }],
        stateMapping: { Active: "in_progress" },
      }}
      onSave={async () => {}}
    />);

    const token = screen.getByLabelText("Personal access token") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("Leave blank to keep the saved token");
  });
});
