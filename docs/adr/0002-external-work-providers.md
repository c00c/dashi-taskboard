# ADR 0002: Integrate Jira and ADO through external-work providers

## Status

Proposed

## Context

Taskboard currently represents local and Jira work directly in shared types,
persistence, routes, and mutation rules. Adding ADO as another set of
source-specific branches would spread provider knowledge further and make later
providers more expensive.

The accepted ADO scope is repository/workspace mapping, work-item
synchronization, and bounded two-way updates. Pull-request, build, policy, and
release dashboard parity is not required.

## Decision

Introduce an External work provider contract before implementing ADO. The
contract covers configuration, discovery, synchronization, external identity,
status mapping, supported mutations, external URLs, and errors.

Add the new provider-neutral form beside the current Jira path, migrate Jira
without changing behavior, then contract the replaced Jira-only routing.

Implement ADO as a provider using stable external origin and work-item keys.
ADO remains authoritative for synchronized remote fields. Supported writes are
bounded by the settled specification, and failed remote writes do not produce a
success-shaped local mutation.

## Consequences

- Jira and ADO share domain vocabulary and observable server behavior.
- Existing Jira data and configuration remain compatible.
- ADO lifecycle mapping must be explicit and configurable.
- Provider tests can exercise the public Taskboard API with controlled remote
  implementations.
- Provider generalization is a sequenced expand-migrate-contract change rather
  than a single breaking source rename.
- Full ADO Work Hub parity remains a separate future decision.
