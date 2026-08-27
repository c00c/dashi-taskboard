import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type {
  AdoConnection,
  AdoConfigurationInput,
  AdoDiscoveryInput,
  AdoDiscoveredProject,
  TaskStatus,
} from "../types";

interface RepositoryDraft {
  selected: boolean;
  workspacePath: string;
  workItemIds: string;
}

interface AdoConnectionDialogProps {
  connection: AdoConnection;
  repositories: AdoDiscoveredProject[];
  busy: boolean;
  error: string | null;
  status: string | null;
  onClose: () => void;
  onDiscover: (input: AdoDiscoveryInput) => Promise<void>;
  onSave: (input: AdoConfigurationInput) => Promise<void>;
  onSync: () => Promise<void>;
}

function projectsFromText(value: string) {
  return value
    .split(/[\n,，]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, ...nameParts] = entry.split("|");
      const projectId = id.trim();
      return { id: projectId, name: nameParts.join("|").trim() || projectId };
    });
}

function stateMappingFromText(value: string): Record<string, TaskStatus> {
  const mapping: Record<string, TaskStatus> = {};
  const statuses = new Set<TaskStatus>([
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "canceled",
  ]);
  for (const line of value.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = line.indexOf("=");
    const remoteState = line.slice(0, separator).trim();
    const status = line.slice(separator + 1).trim() as TaskStatus;
    if (separator < 1 || !remoteState || !statuses.has(status)) {
      throw new Error(`Invalid state mapping: ${line}`);
    }
    mapping[remoteState] = status;
  }
  if (Object.keys(mapping).length === 0) throw new Error("Enter at least one state mapping");
  return mapping;
}

function workItemIdsFromText(value: string) {
  const ids = value.split(/[\s,，]+/).map((entry) => entry.trim()).filter(Boolean);
  if (ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error("Work item IDs must be positive integers");
  }
  return [...new Set(ids.map(Number))];
}

function initialRepositoryDrafts(connection: AdoConnection): Record<string, RepositoryDraft> {
  return Object.fromEntries(connection.projects.flatMap((project) => (
    project.repositories.map((repository) => [
      repository.id,
      {
        selected: true,
        workspacePath: repository.workspacePath,
        workItemIds: repository.workItemIds.join(", "),
      },
    ])
  )));
}

export function AdoConnectionDialog({
  connection,
  repositories,
  busy,
  error,
  status,
  onClose,
  onDiscover,
  onSave,
  onSync,
}: AdoConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [organization, setOrganization] = useState(connection.organization ?? "");
  const [personalAccessToken, setPersonalAccessToken] = useState("");
  const [projectsText, setProjectsText] = useState(
    connection.projects.map((project) => (
      project.name === project.id ? project.id : `${project.id} | ${project.name}`
    )).join("\n"),
  );
  const [stateMappingsText, setStateMappingsText] = useState(
    Object.entries(connection.stateMapping).map(([state, taskStatus]) => (
      `${state} = ${taskStatus}`
    )).join("\n"),
  );
  const [repositoryDrafts, setRepositoryDrafts] = useState<Record<string, RepositoryDraft>>(
    () => initialRepositoryDrafts(connection),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setRepositoryDrafts((current) => {
      const next = { ...current };
      for (const repository of repositories) {
        next[repository.repository.id] ??= {
          selected: false,
          workspacePath: "",
          workItemIds: "",
        };
      }
      return next;
    });
  }, [repositories]);

  const selectedCount = useMemo(() => (
    Object.values(repositoryDrafts).filter((draft) => draft.selected).length
  ), [repositoryDrafts]);

  function updateRepository(id: string, update: Partial<RepositoryDraft>) {
    setRepositoryDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? {
          selected: false,
          workspacePath: "",
          workItemIds: "",
        }),
        ...update,
      },
    }));
  }

  async function discover() {
    setFormError(null);
    const projects = projectsFromText(projectsText);
    if (!organization.trim() || projects.length === 0) {
      setFormError(text("请输入组织和至少一个项目。", "Enter an organization and at least one project."));
      return;
    }
    try {
      await onDiscover({
        organization: organization.trim(),
        personalAccessToken,
        projects,
      });
    } catch {
      // The parent renders the public API error.
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    try {
      const enteredProjects = projectsFromText(projectsText);
      const projects = enteredProjects.map((project) => ({
        ...project,
        repositories: repositories
          .filter((repository) => (
            repository.repository.configuredProjectId === project.id
            && repositoryDrafts[repository.repository.id]?.selected
          ))
          .map((repository) => {
            const draft = repositoryDrafts[repository.repository.id];
            if (!draft.workspacePath.trim()) {
              throw new Error(`Enter a local workspace for ${repository.name}`);
            }
            return {
              id: repository.repository.id,
              workspacePath: draft.workspacePath.trim(),
              workItemIds: workItemIdsFromText(draft.workItemIds),
            };
          }),
      }));
      if (projects.every((project) => project.repositories.length === 0)) {
        throw new Error("Select at least one repository");
      }
      await onSave({
        organization: organization.trim(),
        personalAccessToken,
        projects,
        stateMapping: stateMappingFromText(stateMappingsText),
      });
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Invalid Azure DevOps configuration");
    }
  }

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="delete-dialog project-create-dialog ado-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ado-connection-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <h2 id="ado-connection-title">
          {connection.configured
            ? text("Azure DevOps 设置", "Azure DevOps settings")
            : text("连接 Azure DevOps", "Connect Azure DevOps")}
        </h2>
        <div className="ado-dialog-scroll">
          <div className="ado-field-grid">
            <label>
              <span>{text("组织", "Organization")}</span>
              <input
                autoFocus
                required
                maxLength={128}
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
              />
            </label>
            <label>
              <span>{text("个人访问令牌", "Personal access token")}</span>
              <input
                required={!connection.configured || organization.trim() !== connection.organization}
                type="password"
                autoComplete="current-password"
                maxLength={4096}
                placeholder={connection.configured
                  ? text("留空以保留已保存的令牌", "Leave blank to keep the saved token")
                  : ""}
                value={personalAccessToken}
                onChange={(event) => setPersonalAccessToken(event.target.value)}
              />
            </label>
          </div>
          <label>
            <span>{text("项目（每行：ID | 名称）", "Projects")}</span>
            <textarea
              required
              rows={3}
              placeholder="project-one | Project One"
              value={projectsText}
              onChange={(event) => setProjectsText(event.target.value)}
            />
          </label>
          <button
            className="button secondary ado-discover-button"
            type="button"
            disabled={busy || !organization.trim() || !projectsText.trim()}
            onClick={() => void discover()}
          >
            {text("发现存储库", "Discover repositories")}
          </button>

          {repositories.length > 0 && (
            <fieldset className="ado-repositories">
              <legend>{text("存储库和本地工作", "Repositories and local work")}</legend>
              {repositories.map((repository) => {
                const draft = repositoryDrafts[repository.repository.id] ?? {
                  selected: false,
                  workspacePath: "",
                  workItemIds: "",
                };
                return (
                  <div className="ado-repository" key={repository.repository.id}>
                    <label className="ado-repository-choice">
                      <input
                        type="checkbox"
                        checked={draft.selected}
                        onChange={(event) => updateRepository(
                          repository.repository.id,
                          { selected: event.target.checked },
                        )}
                      />
                      <span>{repository.name}</span>
                    </label>
                    {draft.selected && (
                      <div className="ado-field-grid">
                        <label>
                          <span>{text("绝对本地工作区", `Local workspace for ${repository.name}`)}</span>
                          <input
                            required
                            aria-label={`Local workspace for ${repository.name}`}
                            placeholder={"C:\\work\\repository"}
                            value={draft.workspacePath}
                            onChange={(event) => updateRepository(
                              repository.repository.id,
                              { workspacePath: event.target.value },
                            )}
                          />
                        </label>
                        <label>
                          <span>{text("工作项 ID", `Work item IDs for ${repository.name}`)}</span>
                          <input
                            aria-label={`Work item IDs for ${repository.name}`}
                            inputMode="numeric"
                            placeholder="42, 84"
                            value={draft.workItemIds}
                            onChange={(event) => updateRepository(
                              repository.repository.id,
                              { workItemIds: event.target.value },
                            )}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}

          <label>
            <span>{text("状态映射（每行：ADO 状态 = Taskboard 状态）", "State mappings")}</span>
            <textarea
              required
              aria-label="State mappings"
              rows={5}
              placeholder={"New = todo\nActive = in_progress\nResolved = in_review\nClosed = done"}
              value={stateMappingsText}
              onChange={(event) => setStateMappingsText(event.target.value)}
            />
          </label>
          <p className="ado-statuses">
            {text(
              "可用状态：backlog、todo、in_progress、in_review、blocked、done、canceled",
              "Statuses: backlog, todo, in_progress, in_review, blocked, done, canceled",
            )}
          </p>
          {(formError || error) && (
            <p className="project-dialog-error" role="alert">{formError ?? error}</p>
          )}
          {status && <p className="ado-dialog-status" role="status">{status}</p>}
        </div>
        <div className="ado-dialog-actions">
          {connection.configured && (
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onSync()}>
              {text("立即同步", "Sync now")}
            </button>
          )}
          <span className="ado-dialog-spacer" />
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || selectedCount === 0 || !stateMappingsText.trim()}
          >
            {busy ? text("处理中…", "Working…") : text("保存并同步", "Save and sync")}
          </button>
        </div>
      </form>
    </div>
  );
}
