import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { TASK_STATUSES } from "../shared/domain.mjs";

const CONFIG_VERSION = 1;

export class AdoConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdoConfigError";
    this.code = code;
  }
}

function requiredString(value, field, maxLength = 256) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AdoConfigError("INVALID_ADO_CONFIG", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateOrganization(value) {
  const organization = requiredString(value, "organization", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(organization)) {
    throw new AdoConfigError(
      "INVALID_ADO_ORGANIZATION",
      "Azure DevOps organization must contain only letters, numbers, and hyphens",
    );
  }
  return organization;
}

function validateToken(value) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw new AdoConfigError(
      "INVALID_ADO_TOKEN",
      "Azure DevOps personal access token is required",
    );
  }
  return value;
}

function validateWorkItemIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2000) {
    throw new AdoConfigError(
      "INVALID_ADO_WORK_ITEMS",
      "workItemIds must be an array containing at most 2000 IDs",
    );
  }
  const ids = value.map((id) => {
    if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) {
      throw new AdoConfigError(
        "INVALID_ADO_WORK_ITEMS",
        "Azure DevOps work item IDs must be positive integers",
      );
    }
    return id;
  });
  return [...new Set(ids)];
}

function validateProjects(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new AdoConfigError(
      "INVALID_ADO_PROJECTS",
      "Azure DevOps projects must contain between 1 and 50 entries",
    );
  }
  const selectedWorkItems = new Set();
  const projects = value.map((project) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new AdoConfigError("INVALID_ADO_PROJECTS", "Each Azure DevOps project must be an object");
    }
    const allowedKeys = new Set(["id", "name", "repositories"]);
    if (Object.keys(project).some((key) => !allowedKeys.has(key))) {
      throw new AdoConfigError("INVALID_ADO_PROJECTS", "Azure DevOps project contains unknown fields");
    }
    const repositories = project.repositories ?? [];
    if (!Array.isArray(repositories) || repositories.length > 100) {
      throw new AdoConfigError(
        "INVALID_ADO_REPOSITORIES",
        "repositories must be an array containing at most 100 mappings",
      );
    }
    const repositoryIds = new Set();
    return {
      id: requiredString(project.id, "project.id"),
      name: requiredString(project.name ?? project.id, "project.name"),
      repositories: repositories.map((repository) => {
        if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
          throw new AdoConfigError(
            "INVALID_ADO_REPOSITORIES",
            "Each repository mapping must be an object",
          );
        }
        const repositoryKeys = new Set(["id", "workspacePath", "workItemIds"]);
        if (Object.keys(repository).some((key) => !repositoryKeys.has(key))) {
          throw new AdoConfigError(
            "INVALID_ADO_REPOSITORIES",
            "Azure DevOps repository mapping contains unknown fields",
          );
        }
        const id = requiredString(repository.id, "repository.id");
        if (repositoryIds.has(id)) {
          throw new AdoConfigError(
            "INVALID_ADO_REPOSITORIES",
            `Repository '${id}' is mapped more than once`,
          );
        }
        repositoryIds.add(id);
        const workspacePath = requiredString(repository.workspacePath, "repository.workspacePath", 4096);
        if (!path.isAbsolute(workspacePath)) {
          throw new AdoConfigError(
            "INVALID_ADO_WORKSPACE",
            `Workspace for repository '${id}' must be an absolute path`,
          );
        }
        const workItemIds = validateWorkItemIds(repository.workItemIds);
        for (const workItemId of workItemIds) {
          if (selectedWorkItems.has(workItemId)) {
            throw new AdoConfigError(
              "INVALID_ADO_WORK_ITEMS",
              `Work item '${workItemId}' is assigned to more than one repository`,
            );
          }
          selectedWorkItems.add(workItemId);
        }
        return { id, workspacePath, workItemIds };
      }),
    };
  });
  const projectIds = projects.map((project) => project.id);
  if (new Set(projectIds).size !== projectIds.length) {
    throw new AdoConfigError("INVALID_ADO_PROJECTS", "Azure DevOps project IDs must be unique");
  }
  return projects;
}

function validateStateMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdoConfigError(
      "INVALID_ADO_STATE_MAPPING",
      "stateMapping must explicitly map Azure DevOps states to Taskboard statuses",
    );
  }
  const mapping = {};
  for (const [remoteState, status] of Object.entries(value)) {
    const normalizedState = requiredString(remoteState, "stateMapping state", 128);
    if (!TASK_STATUSES.includes(status)) {
      throw new AdoConfigError(
        "INVALID_ADO_STATE_MAPPING",
        `Azure DevOps state '${normalizedState}' maps to unsupported Taskboard status '${status}'`,
      );
    }
    mapping[normalizedState] = status;
  }
  if (Object.keys(mapping).length === 0) {
    throw new AdoConfigError(
      "INVALID_ADO_STATE_MAPPING",
      "stateMapping must contain at least one explicit mapping",
    );
  }
  return mapping;
}

function parseConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdoConfigError("INVALID_ADO_CONFIG", "Azure DevOps configuration must be an object");
  }
  const allowedKeys = new Set([
    "version",
    "organization",
    "personalAccessToken",
    "projects",
    "stateMapping",
  ]);
  if (
    value.version !== CONFIG_VERSION
    || Object.keys(value).some((key) => !allowedKeys.has(key))
  ) {
    throw new AdoConfigError("INVALID_ADO_CONFIG", "Azure DevOps configuration is invalid");
  }
  return {
    version: CONFIG_VERSION,
    organization: validateOrganization(value.organization),
    personalAccessToken: validateToken(value.personalAccessToken),
    projects: validateProjects(value.projects),
    stateMapping: validateStateMapping(value.stateMapping),
  };
}

export function createAdoConfigStore({ configPath }) {
  if (!configPath) throw new Error("configPath is required");
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return parseConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeAtomically(config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  }

  return {
    async read() {
      await pendingWrite;
      return readFromDisk();
    },
    validate(input) {
      return parseConfig({ ...input, version: CONFIG_VERSION });
    },
    async save(input) {
      const config = parseConfig({ ...input, version: CONFIG_VERSION });
      const operation = pendingWrite.catch(() => {}).then(async () => {
        await writeAtomically(config);
        return config;
      });
      pendingWrite = operation.catch(() => {});
      return operation;
    },
    async clear() {
      await pendingWrite;
      try {
        await unlink(configPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}
