import { createHash } from "node:crypto";

import {
  ExternalWorkProviderError,
} from "./external-work-providers.mjs";

const API_VERSION = "7.1";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const WORK_ITEM_BATCH_SIZE = 200;
const ADO_DESCRIPTOR_ACTOR_PREFIX = "ado:descriptor:";
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
const ADO_IDENTITY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const descriptor = typeof identity?.descriptor === "string" ? identity.descriptor.trim() : "";
  const descriptorId = descriptor ? `${ADO_DESCRIPTOR_ACTOR_PREFIX}${descriptor}` : "";
  const id = String(identity?.id ?? identity?.uniqueName ?? fallback).trim().slice(0, 240);
  return {
    type: "user",
    id: descriptorId && descriptorId.length <= 240 ? descriptorId : `ado:${id || fallback}`,
    name: String(identity?.displayName ?? identity?.uniqueName ?? fallback).trim().slice(0, 120),
    avatarUrl: null,
  };
}

const UNASSIGNED_ACTOR = {
  type: "user",
  id: "unassigned",
  name: "Unassigned",
  avatarUrl: null,
};

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
    const {
      baseUrl,
      apiVersion = API_VERSION,
      retryable = (init.method ?? "GET") === "GET",
      indeterminateCode,
      returnResponseMetadata = false,
      ...fetchInit
    } = init;
    const url = new URL(baseUrl
      ? `${baseUrl.replace(/\/$/, "")}${apiPath}`
      : adoUrl(config, projectId, apiPath));
    url.searchParams.set("api-version", apiVersion);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      let response;
      try {
        response = await fetchImplementation(url, {
          ...fetchInit,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Basic ${Buffer.from(`:${config.personalAccessToken}`, "utf8").toString("base64")}`,
            ...(fetchInit.body ? { "content-type": "application/json" } : {}),
            ...fetchInit.headers,
          },
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        if (retryable && attempt + 1 < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
          continue;
        }
        throw new ExternalWorkProviderError(
          502,
          indeterminateCode ?? (timedOut ? "ADO_TIMEOUT" : "ADO_UNAVAILABLE"),
          timedOut
            ? (indeterminateCode
              ? "The Azure DevOps mutation may have succeeded, but its response timed out; synchronize before retrying"
              : "Azure DevOps request timed out")
            : (indeterminateCode
              ? "The Azure DevOps mutation may have succeeded, but its response was lost; synchronize before retrying"
              : "Azure DevOps is unavailable; check the organization and network connection"),
        );
      } finally {
        clearTimeout(timeout);
      }

      if (TRANSIENT_STATUSES.has(response.status) && retryable && attempt + 1 < MAX_ATTEMPTS) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
        continue;
      }
      if (TRANSIENT_STATUSES.has(response.status) && indeterminateCode) {
        throw new ExternalWorkProviderError(
          502,
          indeterminateCode,
          "Azure DevOps may have accepted the mutation before returning a transient failure; synchronize before retrying",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ExternalWorkProviderError(
          401,
          "ADO_AUTH_FAILED",
          "Azure DevOps authentication failed; check the personal access token and required work scopes",
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
        const payload = await response.json();
        return returnResponseMetadata ? { payload, headers: response.headers } : payload;
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
        configuredProjectId: repository.configuredProject.id,
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
          retryable: true,
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

  async function listWorkItemComments(config, projectId, workItemId) {
    const comments = [];
    let continuationToken = null;
    do {
      const query = new URLSearchParams({ $top: "200" });
      if (continuationToken) query.set("continuationToken", continuationToken);
      const page = await request(
        config,
        projectId,
        `/_apis/wit/workitems/${workItemId}/comments?${query}`,
        { returnResponseMetadata: true },
      );
      const values = Array.isArray(page.payload?.comments)
        ? page.payload.comments
        : responseValues(page.payload, "comment");
      comments.push(...values);
      continuationToken = page.headers.get("x-ms-continuationtoken")
        ?? page.payload?.continuationToken
        ?? null;
    } while (continuationToken);
    return comments;
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

  async function synchronizeSnapshot() {
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
    const comments = [];
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
              : UNASSIGNED_ACTOR,
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
          const remoteComments = await listWorkItemComments(
            config,
            configuredProject.id,
            externalId,
          );
          for (const comment of remoteComments) {
            const commentId = String(comment?.commentId ?? comment?.id ?? "");
            if (!commentId || comment?.isDeleted === true) continue;
            comments.push({
              externalOrigin: originFor(config),
              externalId,
              id: commentId,
              body: String(comment.text ?? ""),
              actor: actorFromIdentity(comment.createdBy, "ado-commenter"),
              createdAt: String(
                comment.createdDate
                ?? comment.modifiedDate
                ?? fields["System.ChangedDate"]
                ?? new Date().toISOString(),
              ),
            });
          }
        }
      }
    }
    return { projects, tasks, comments };
  }

  async function mutationContext(identity) {
    const config = await configStore.read();
    if (!config) {
      throw new ExternalWorkProviderError(
        409,
        "ADO_NOT_CONFIGURED",
        "Azure DevOps is not configured",
      );
    }
    if (identity.origin !== originFor(config) || !/^[1-9]\d*$/.test(identity.id)) {
      throw new ExternalWorkProviderError(
        409,
        "ADO_WORK_ITEM_IDENTITY_INVALID",
        "The synchronized Azure DevOps work item identity is invalid",
      );
    }
    const workItemId = Number(identity.id);
    const matches = config.projects.filter((project) => project.repositories.some(
      (repository) => repository.workItemIds.includes(workItemId),
    ));
    if (matches.length !== 1) {
      throw new ExternalWorkProviderError(
        409,
        "ADO_WORK_ITEM_MAPPING_INVALID",
        `Azure DevOps work item '${identity.id}' must belong to exactly one configured project`,
      );
    }
    return { config, project: matches[0], workItemId };
  }

  const provider = {
    id: "ado",
    displayName: "Azure DevOps",
    supportedMutations: ["status", "assignee"],
    localOnlyMutations: ["developmentContext"],
    supportsComments: true,
    authoritativeMutations: true,
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
    async discoverProjects(input) {
      const current = await configStore.read();
      let config = current;
      if (input) {
        const personalAccessToken = input.personalAccessToken || current?.personalAccessToken;
        if (
          !input.personalAccessToken
          && (!current || input.organization !== current.organization)
        ) {
          throw new ExternalWorkProviderError(
            400,
            "ADO_TOKEN_REQUIRED",
            "A personal access token is required when discovering a new Azure DevOps organization",
          );
        }
        try {
          config = configStore.validateDiscovery({ ...input, personalAccessToken });
        } catch (error) {
          throw new ExternalWorkProviderError(
            400,
            error?.code ?? "INVALID_ADO_CONFIG",
            error instanceof Error ? error.message : "Azure DevOps discovery configuration is invalid",
          );
        }
      }
      if (!config) {
        throw new ExternalWorkProviderError(
          409,
          "ADO_NOT_CONFIGURED",
          "Azure DevOps is not configured",
        );
      }
      const repositories = await listRepositories(config);
      if (!input) await validateRepositoryMappings(config, repositories);
      return repositories.map((repository) => mappedProject(config, repository));
    },
    async discoverActors() {
      const config = await configStore.read();
      if (!config) {
        throw new ExternalWorkProviderError(
          409,
          "ADO_NOT_CONFIGURED",
          "Azure DevOps is not configured",
        );
      }
      const actors = [];
      let continuationToken = null;
      do {
        const query = new URLSearchParams({ $top: "1000" });
        if (continuationToken) query.set("continuationToken", continuationToken);
        const page = await request(
          config,
          null,
          `/_apis/graph/users?${query}`,
          {
            baseUrl: `https://vssps.dev.azure.com/${encodeURIComponent(config.organization)}/`,
            apiVersion: "7.1-preview.1",
            returnResponseMetadata: true,
          },
        );
        for (const user of responseValues(page.payload, "user")) {
          if (typeof user?.descriptor !== "string" || !user.descriptor || !user?.displayName) continue;
          const actorId = `${ADO_DESCRIPTOR_ACTOR_PREFIX}${user.descriptor}`;
          if (actorId.length > 240) continue;
          actors.push({
            type: "user",
            id: actorId,
            name: String(user.displayName).trim().slice(0, 120),
            avatarUrl: null,
          });
        }
        continuationToken = page.headers.get("x-ms-continuationtoken");
      } while (continuationToken);
      return actors.filter((actor, index) => (
        actors.findIndex((candidate) => candidate.id === actor.id) === index
      ));
    },
    async synchronize() {
      return synchronizeSnapshot();
    },
    mapStatus,
    async mutateTask({ identity, changes }) {
      const { config, project, workItemId } = await mutationContext(identity);
      activeStateMapping = config.stateMapping;
      const patch = [];
      if (Object.hasOwn(changes, "status")) {
        const remoteStates = Object.entries(config.stateMapping)
          .filter(([, status]) => status === changes.status)
          .map(([remoteState]) => remoteState);
        if (remoteStates.length !== 1) {
          throw new ExternalWorkProviderError(
            409,
            "ADO_STATE_MAPPING_AMBIGUOUS",
            `Taskboard status '${changes.status}' must map to exactly one Azure DevOps state`,
          );
        }
        patch.push({
          op: "add",
          path: "/fields/System.State",
          value: remoteStates[0],
        });
      }
      if (Object.hasOwn(changes, "assignee")) {
        if (changes.assignee?.id === UNASSIGNED_ACTOR.id) {
          patch.push({ op: "remove", path: "/fields/System.AssignedTo" });
        } else {
          const actorId = typeof changes.assignee?.id === "string"
            ? changes.assignee.id
            : "";
          let identityId = actorId.startsWith("ado:") ? actorId.slice(4) : actorId;
          if (
            changes.assignee?.type === "user"
            && actorId.startsWith(ADO_DESCRIPTOR_ACTOR_PREFIX)
          ) {
            const descriptor = actorId.slice(ADO_DESCRIPTOR_ACTOR_PREFIX.length);
            const storageKey = descriptor
              ? await request(
                config,
                null,
                `/_apis/graph/storagekeys/${encodeURIComponent(descriptor)}`,
                {
                  baseUrl: `https://vssps.dev.azure.com/${encodeURIComponent(config.organization)}/`,
                },
              )
              : null;
            identityId = String(storageKey?.value ?? "");
          }
          if (changes.assignee?.type !== "user" || !ADO_IDENTITY_ID_PATTERN.test(identityId)) {
            throw new ExternalWorkProviderError(
              409,
              "ADO_ASSIGNEE_IDENTITY_INVALID",
              "Azure DevOps assignee changes require an ADO identity or explicit unassignment",
            );
          }
          patch.push({
            op: "add",
            path: "/fields/System.AssignedTo",
            value: { id: identityId },
          });
        }
      }
      await request(
        config,
        project.id,
        `/_apis/wit/workitems/${workItemId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json-patch+json" },
          body: JSON.stringify(patch),
          indeterminateCode: "ADO_MUTATION_INDETERMINATE",
        },
      );
      try {
        return { snapshot: await synchronizeSnapshot() };
      } catch {
        throw new ExternalWorkProviderError(
          502,
          "ADO_REFRESH_FAILED",
          "Azure DevOps accepted the update, but Taskboard could not refresh the authoritative work item; run synchronization to converge",
        );
      }
    },
    async addComment({ identity, body }) {
      const { config, project, workItemId } = await mutationContext(identity);
      const created = await request(
        config,
        project.id,
        `/_apis/wit/workitems/${workItemId}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ text: body }),
          indeterminateCode: "ADO_COMMENT_INDETERMINATE",
        },
      );
      let comment = null;
      try {
        const comments = await listWorkItemComments(config, project.id, workItemId);
        const createdId = String(created?.commentId ?? created?.id ?? "");
        comment = comments.find((candidate) => (
            String(candidate?.commentId ?? candidate?.id ?? "") === createdId
        )) ?? null;
      } catch {
        throw new ExternalWorkProviderError(
          502,
          "ADO_COMMENT_REFRESH_FAILED",
          "Azure DevOps accepted the comment, but Taskboard could not refresh it; run synchronization to converge",
        );
      }
      const createdId = String(created?.commentId ?? created?.id ?? "");
      if (!createdId || !comment || comment.isDeleted === true) {
        throw new ExternalWorkProviderError(
          502,
          "ADO_COMMENT_REFRESH_FAILED",
          "Azure DevOps accepted the comment, but the authoritative comment was not returned",
        );
      }
      return {
        id: createdId,
        body: String(comment.text ?? ""),
        actor: actorFromIdentity(comment.createdBy, "ado-commenter"),
        createdAt: String(comment.createdDate ?? comment.modifiedDate ?? new Date().toISOString()),
      };
    },
  };

  return { provider };
}
