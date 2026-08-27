import { createHash } from "node:crypto";

import {
  ExternalWorkProviderError,
} from "./external-work-providers.mjs";

const API_VERSION = "7.1";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const WORK_ITEM_BATCH_SIZE = 200;
const WORK_ITEM_FIELDS = [
  "System.Id",
  "System.Title",
  "System.Description",
  "System.State",
  "System.Tags",
  "System.AssignedTo",
  "System.CreatedBy",
  "System.CreatedDate",
  "System.ChangedDate",
  "Microsoft.VSTS.Common.Priority",
];
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function safeConnection(config) {
  if (!config) {
    return {
      configured: false,
      organization: null,
      projects: [],
      stateMapping: {},
    };
  }
  return {
    configured: true,
    organization: config.organization,
    projects: config.projects,
    stateMapping: config.stateMapping,
  };
}

function originFor(config) {
  return `ado:${config.organization.toLowerCase()}`;
}

function projectSlug(repositoryId) {
  const normalized = repositoryId.toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/.test(normalized)) {
    return `ado-${normalized}`;
  }
  return `ado-${createHash("sha256").update(repositoryId).digest("hex").slice(0, 32)}`;
}

function adoUrl(config, projectId, pathname) {
  return `https://dev.azure.com/${encodeURIComponent(config.organization)}/${encodeURIComponent(projectId)}${pathname}`;
}

function actorFromIdentity(identity, fallback) {
  const id = String(identity?.id ?? identity?.uniqueName ?? fallback).trim().slice(0, 240);
  return {
    type: "user",
    id: `ado:${id || fallback}`,
    name: String(identity?.displayName ?? identity?.uniqueName ?? fallback).trim().slice(0, 120),
    avatarUrl: null,
  };
}

function priorityFromWorkItem(value) {
  if (value === 1) return "urgent";
  if (value === 2) return "high";
  if (value === 3) return "medium";
  if (value === 4) return "low";
  return "none";
}

function labelsFromWorkItem(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(";").map((label) => label.trim()).filter(Boolean))].slice(0, 20);
}

function responseValues(payload, label) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.value)) return payload.value;
  throw new ExternalWorkProviderError(
    502,
    "INVALID_ADO_RESPONSE",
    `Azure DevOps returned an invalid ${label} response`,
  );
}

export function createAdoIntegration({
  configStore,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  let activeStateMapping = {};

  async function request(config, projectId, apiPath, init = {}) {
    const url = new URL(adoUrl(config, projectId, apiPath));
    url.searchParams.set("api-version", API_VERSION);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      let response;
      try {
        response = await fetchImplementation(url, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Basic ${Buffer.from(`:${config.personalAccessToken}`, "utf8").toString("base64")}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers,
          },
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        if (attempt + 1 < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
          continue;
        }
        throw new ExternalWorkProviderError(
          502,
          timedOut ? "ADO_TIMEOUT" : "ADO_UNAVAILABLE",
          timedOut
            ? "Azure DevOps request timed out"
            : "Azure DevOps is unavailable; check the organization and network connection",
        );
      } finally {
        clearTimeout(timeout);
      }

      if (TRANSIENT_STATUSES.has(response.status) && attempt + 1 < MAX_ATTEMPTS) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ExternalWorkProviderError(
          401,
          "ADO_AUTH_FAILED",
          "Azure DevOps authentication failed; check the personal access token and required read scopes",
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ExternalWorkProviderError(
          400,
          "ADO_REDIRECT",
          "Azure DevOps unexpectedly redirected the API request",
        );
      }
      if (!response.ok) {
        throw new ExternalWorkProviderError(
          response.status >= 500 || response.status === 429 ? 502 : 409,
          "ADO_REQUEST_FAILED",
          `Azure DevOps request failed (HTTP ${response.status})`,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new ExternalWorkProviderError(
          502,
          "INVALID_ADO_RESPONSE",
          "Azure DevOps returned invalid JSON",
        );
      }
    }
    throw new Error("Azure DevOps request retry loop exited unexpectedly");
  }

  async function listRepositories(config) {
    const repositories = [];
    for (const configuredProject of config.projects) {
      const payload = await request(
        config,
        configuredProject.id,
        "/_apis/git/repositories",
      );
      for (const repository of responseValues(payload, "repository")) {
        if (!repository?.id || !repository?.name) {
          throw new ExternalWorkProviderError(
            502,
            "INVALID_ADO_RESPONSE",
            "Azure DevOps returned a repository without a stable ID or name",
          );
        }
        repositories.push({
          ...repository,
          configuredProject,
        });
      }
    }
    return repositories;
  }

  function mappedProject(config, repository) {
    const mapping = repository.configuredProject.repositories.find(
      (candidate) => candidate.id === repository.id,
    );
    const projectName = String(repository.project?.name ?? repository.configuredProject.name);
    return {
      id: projectSlug(String(repository.id)),
      name: `${projectName} · ${String(repository.name)}`.slice(0, 120),
      labels: ["ado"],
      workspacePath: mapping?.workspacePath ?? null,
      repository: {
        id: String(repository.id),
        name: String(repository.name),
        projectId: String(repository.project?.id ?? repository.configuredProject.id),
        projectName,
      },
      externalOrigin: originFor(config),
      externalId: String(repository.id),
      externalUrl: adoUrl(
        config,
        repository.configuredProject.id,
        `/_git/${encodeURIComponent(String(repository.name))}`,
      ),
    };
  }

  async function validateRepositoryMappings(config, repositories) {
    const discoveredIds = new Set(repositories.map((repository) => (
      `${repository.configuredProject.id}\0${String(repository.id)}`
    )));
    const missing = config.projects.flatMap((project) => (
      project.repositories
        .filter((repository) => !discoveredIds.has(`${project.id}\0${repository.id}`))
        .map((repository) => `${project.id}/${repository.id}`)
    ));
    if (missing.length > 0) {
      throw new ExternalWorkProviderError(
        409,
        "ADO_REPOSITORY_NOT_FOUND",
        `Azure DevOps repository mappings were not discovered: ${missing.join(", ")}`,
      );
    }
  }

  async function fetchWorkItems(config, project, ids) {
    const workItems = [];
    for (let start = 0; start < ids.length; start += WORK_ITEM_BATCH_SIZE) {
      const batch = ids.slice(start, start + WORK_ITEM_BATCH_SIZE);
      const payload = await request(
        config,
        project.id,
        "/_apis/wit/workitemsbatch",
        {
          method: "POST",
          body: JSON.stringify({
            ids: batch,
            fields: WORK_ITEM_FIELDS,
            errorPolicy: "fail",
          }),
        },
      );
      workItems.push(...responseValues(payload, "work item batch"));
    }
    const returnedIds = new Set(
      workItems.map((workItem) => Number(workItem?.id ?? workItem?.fields?.["System.Id"])),
    );
    const missingIds = ids.filter((id) => !returnedIds.has(id));
    if (missingIds.length > 0) {
      throw new ExternalWorkProviderError(
        409,
        "ADO_WORK_ITEMS_NOT_FOUND",
        `Azure DevOps did not return selected work items: ${missingIds.join(", ")}`,
      );
    }
    return workItems;
  }

  function mapStatus(remoteStatus) {
    const status = activeStateMapping[remoteStatus];
    if (!status) {
      throw new ExternalWorkProviderError(
        409,
        "ADO_STATE_UNMAPPED",
        `Azure DevOps state '${remoteStatus}' has no configured Taskboard status mapping`,
      );
    }
    return status;
  }

  function validateConfiguration(input) {
    try {
      return configStore.validate(input);
    } catch (error) {
      throw new ExternalWorkProviderError(
        400,
        error?.code ?? "INVALID_ADO_CONFIG",
        error instanceof Error ? error.message : "Azure DevOps configuration is invalid",
      );
    }
  }

  const provider = {
    id: "ado",
    displayName: "Azure DevOps",
    supportedMutations: [],
    async getConnection() {
      return safeConnection(await configStore.read());
    },
    async configure(input) {
      const current = await configStore.read();
      const personalAccessToken = input.personalAccessToken || current?.personalAccessToken;
      if (
        !input.personalAccessToken
        && (!current || input.organization !== current.organization)
      ) {
        throw new ExternalWorkProviderError(
          400,
          "ADO_TOKEN_REQUIRED",
          "A personal access token is required when configuring a new Azure DevOps organization",
        );
      }
      const candidate = validateConfiguration({ ...input, personalAccessToken });
      const repositories = await listRepositories(candidate);
      await validateRepositoryMappings(candidate, repositories);
      activeStateMapping = candidate.stateMapping;
      await configStore.save(candidate);
    },
    async discoverProjects() {
      const config = await configStore.read();
      if (!config) {
        throw new ExternalWorkProviderError(
          409,
          "ADO_NOT_CONFIGURED",
          "Azure DevOps is not configured",
        );
      }
      const repositories = await listRepositories(config);
      await validateRepositoryMappings(config, repositories);
      return repositories.map((repository) => mappedProject(config, repository));
    },
    async synchronize() {
      const config = await configStore.read();
      if (!config) {
        throw new ExternalWorkProviderError(
          409,
          "ADO_NOT_CONFIGURED",
          "Azure DevOps is not configured",
        );
      }
      activeStateMapping = config.stateMapping;
      const repositories = await listRepositories(config);
      await validateRepositoryMappings(config, repositories);
      const repositoriesById = new Map(
        repositories.map((repository) => [
          `${repository.configuredProject.id}\0${String(repository.id)}`,
          repository,
        ]),
      );
      const projects = [];
      const tasks = [];
      for (const configuredProject of config.projects) {
        for (const repositoryMapping of configuredProject.repositories) {
          const repository = repositoriesById.get(
            `${configuredProject.id}\0${repositoryMapping.id}`,
          );
          const project = mappedProject(config, repository);
          projects.push(project);
          const workItems = await fetchWorkItems(
            config,
            configuredProject,
            repositoryMapping.workItemIds,
          );
          for (const [index, workItem] of workItems.entries()) {
            const fields = workItem?.fields ?? {};
            const externalId = String(workItem?.id ?? fields["System.Id"] ?? "");
            if (!externalId) {
              throw new ExternalWorkProviderError(
                502,
                "INVALID_ADO_RESPONSE",
                "Azure DevOps returned a work item without a stable ID",
              );
            }
            const remoteStatus = String(fields["System.State"] ?? "");
            mapStatus(remoteStatus);
            const creator = actorFromIdentity(fields["System.CreatedBy"], "ado-creator");
            tasks.push({
              projectId: project.id,
              title: String(fields["System.Title"] ?? `Work item ${externalId}`).slice(0, 240),
              description: typeof fields["System.Description"] === "string"
                ? fields["System.Description"].slice(0, 100_000)
                : "",
              remoteStatus,
              priority: priorityFromWorkItem(fields["Microsoft.VSTS.Common.Priority"]),
              labels: labelsFromWorkItem(fields["System.Tags"]),
              sortOrder: (index + 1) * 1024,
              creator,
              assignee: fields["System.AssignedTo"]
                ? actorFromIdentity(fields["System.AssignedTo"], "ado-assignee")
                : creator,
              dueDate: null,
              externalOrigin: originFor(config),
              externalId,
              externalKey: externalId,
              externalUrl: adoUrl(
                config,
                configuredProject.id,
                `/_workitems/edit/${encodeURIComponent(externalId)}`,
              ),
              createdAt: fields["System.CreatedDate"],
              updatedAt: fields["System.ChangedDate"],
            });
          }
        }
      }
      return { projects, tasks };
    },
    mapStatus,
    async mutateTask() {
      throw new ExternalWorkProviderError(
        409,
        "ADO_MUTATION_UNAVAILABLE",
        "Azure DevOps write-back is not enabled",
      );
    },
  };

  return { provider };
}
