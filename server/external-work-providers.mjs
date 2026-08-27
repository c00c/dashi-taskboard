import { createHash } from "node:crypto";

import { TASK_STATUSES } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RESERVED_PROVIDER_IDS = new Set(["local"]);
const MUTATIONS = new Set([
  "status",
  "title",
  "description",
  "priority",
  "labels",
  "dueDate",
  "assignee",
]);

export class ExternalWorkProviderError extends ApiError {
  constructor(status, code, message, details) {
    super(status, code, message, details);
    this.name = "ExternalWorkProviderError";
  }
}

function requireString(value, label, maxLength = 2048) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value.trim();
}

function requireUrl(value, label) {
  const url = requireString(value, label);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${label} must be an HTTP or HTTPS URL`);
  }
  return url;
}

function normalizeActor(actor, providerId) {
  return {
    type: actor?.type === "agent" ? "agent" : "user",
    id: requireString(actor?.id ?? `${providerId}-user`, "actor.id", 240),
    name: requireString(actor?.name ?? providerId, "actor.name", 120),
    avatarUrl: actor?.avatarUrl == null ? null : requireUrl(actor.avatarUrl, "actor.avatarUrl"),
  };
}

function normalizeProject(providerId, project) {
  const id = requireString(project?.id, "project.id", 64);
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error("project.id must be a lowercase slug");
  }
  return {
    id,
    name: requireString(project?.name, "project.name", 120),
    labels: Array.isArray(project?.labels) ? project.labels : [],
    externalOrigin: requireString(project?.externalOrigin, "project.externalOrigin", 512),
    externalId: requireString(project?.externalId, "project.externalId", 512),
    externalUrl: requireUrl(project?.externalUrl, "project.externalUrl"),
    source: providerId,
  };
}

function normalizeTask(provider, task, index, projects) {
  const projectId = requireString(task?.projectId, "task.projectId", 64);
  if (!projects.has(projectId)) throw new Error(`task.projectId '${projectId}' was not discovered`);
  const externalOrigin = requireString(task?.externalOrigin, "task.externalOrigin", 512);
  const externalId = requireString(task?.externalId, "task.externalId", 512);
  const externalKey = requireString(task?.externalKey, "task.externalKey", 128);
  const status = provider.mapStatus(task.remoteStatus);
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`Provider '${provider.id}' mapped a status to unsupported value '${status}'`);
  }
  const priority = ["none", "urgent", "high", "medium", "low"].includes(task.priority)
    ? task.priority
    : "none";
  const creator = normalizeActor(task.creator, provider.id);
  return {
    id: `external:${provider.id}:${createHash("sha256")
      .update(`${externalOrigin}\0${externalId}`)
      .digest("hex")
      .slice(0, 32)}`,
    identifier: `EXT:${provider.id.toUpperCase()}:${createHash("sha256")
      .update(externalOrigin)
      .digest("hex")
      .slice(0, 16)
      .toUpperCase()}:${externalKey}`,
    projectId,
    title: requireString(task.title, "task.title", 240),
    description: typeof task.description === "string" ? task.description.slice(0, 100_000) : "",
    status,
    priority,
    labels: Array.isArray(task.labels) ? task.labels : [],
    sortOrder: Number.isFinite(task.sortOrder) ? task.sortOrder : (index + 1) * 1024,
    creator,
    assignee: normalizeActor(task.assignee ?? creator, provider.id),
    dueDate: typeof task.dueDate === "string" ? task.dueDate : null,
    externalOrigin,
    externalId,
    externalKey,
    externalUrl: requireUrl(task.externalUrl, "task.externalUrl"),
    createdAt: typeof task.createdAt === "string" ? task.createdAt : new Date().toISOString(),
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : new Date().toISOString(),
  };
}

export function createExternalWorkProviderRegistry({ providers = [], database }) {
  const providerMap = new Map();
  for (const provider of providers) {
    const id = requireString(provider?.id, "provider.id", 64);
    if (!PROVIDER_ID_PATTERN.test(id)) throw new Error(`Invalid external work provider id '${id}'`);
    if (RESERVED_PROVIDER_IDS.has(id)) {
      throw new Error(`External work provider id '${id}' is reserved`);
    }
    if (providerMap.has(id)) throw new Error(`Duplicate external work provider '${id}'`);
    for (const method of [
      "getConnection",
      "configure",
      "discoverProjects",
      "synchronize",
      "mapStatus",
      "mutateTask",
    ]) {
      if (typeof provider[method] !== "function") {
        throw new Error(`External work provider '${id}' must implement ${method}()`);
      }
    }
    const supportedMutations = [...new Set(provider.supportedMutations ?? [])];
    if (supportedMutations.some((mutation) => !MUTATIONS.has(mutation))) {
      throw new Error(`External work provider '${id}' declares an unsupported mutation`);
    }
    providerMap.set(id, {
      id,
      displayName: requireString(provider.displayName, "provider.displayName", 120),
      supportedMutations,
      managesSynchronization: provider.managesSynchronization === true,
      getConnection: (...args) => provider.getConnection(...args),
      configure: (...args) => provider.configure(...args),
      discoverProjects: (...args) => provider.discoverProjects(...args),
      synchronize: (...args) => provider.synchronize(...args),
      mapStatus: (...args) => provider.mapStatus(...args),
      mutateTask: (...args) => provider.mutateTask(...args),
    });
  }

  function get(providerId) {
    const provider = providerMap.get(providerId);
    if (!provider) {
      throw new ApiError(404, "EXTERNAL_PROVIDER_NOT_FOUND", `External work provider '${providerId}' is not registered`);
    }
    return provider;
  }

  async function describe(provider) {
    return {
      id: provider.id,
      displayName: provider.displayName,
      connection: await provider.getConnection(),
      supportedMutations: provider.supportedMutations,
    };
  }

  return {
    has(providerId) {
      return providerMap.has(providerId);
    },
    async list() {
      return Promise.all([...providerMap.values()].map(describe));
    },
    async connection(providerId) {
      return get(providerId).getConnection();
    },
    async configure(providerId, configuration) {
      const provider = get(providerId);
      await provider.configure(configuration);
      return describe(provider);
    },
    async discover(providerId) {
      const provider = get(providerId);
      const projects = (await provider.discoverProjects()).map((project) => (
        normalizeProject(provider.id, project)
      ));
      return { provider: await describe(provider), projects };
    },
    async synchronize(providerId, options) {
      const provider = get(providerId);
      const snapshot = await provider.synchronize(options);
      if (provider.managesSynchronization) {
        return {
          provider: await describe(provider),
          projects: snapshot?.projects ?? [],
          tasks: snapshot?.tasks ?? [],
        };
      }
      const projects = (snapshot?.projects ?? []).map((project) => normalizeProject(provider.id, project));
      for (const project of projects) {
        const existing = database.getProject(project.id);
        if (
          existing
          && (
            existing.source !== provider.id
            || existing.externalOrigin !== project.externalOrigin
            || existing.externalId !== project.externalId
          )
        ) {
          throw new ExternalWorkProviderError(
            409,
            "EXTERNAL_PROJECT_ID_CONFLICT",
            `Project id '${project.id}' is already bound to another source`,
          );
        }
      }
      const projectIds = new Set(projects.map((project) => project.id));
      const tasks = (snapshot?.tasks ?? []).map((task, index) => (
        normalizeTask(provider, task, index, projectIds)
      ));
      database.syncExternalWork(provider.id, { projects, tasks });
      return {
        provider: await describe(provider),
        projects: projects.map((project) => database.getProject(project.id)),
        tasks: tasks.map((task) => database.getTaskByExternalIdentity(
          provider.id,
          task.externalOrigin,
          task.externalId,
        )),
      };
    },
    async mutateTask(providerId, task, changes) {
      const provider = get(providerId);
      const unsupported = Object.keys(changes).filter((field) => !provider.supportedMutations.includes(field));
      if (unsupported.length > 0) {
        throw new ExternalWorkProviderError(
          409,
          "EXTERNAL_MUTATION_UNSUPPORTED",
          `Provider '${providerId}' does not support: ${unsupported.join(", ")}`,
          { supportedMutations: provider.supportedMutations },
        );
      }
      return provider.mutateTask({
        identity: {
          providerId,
          origin: task.externalOrigin,
          id: task.externalId,
          key: task.externalKey,
          url: task.externalUrl,
        },
        changes,
      });
    },
  };
}
