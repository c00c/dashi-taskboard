# ADR 0001: Host Taskboard through a user-scoped Copilot canvas overlay

## Status

Proposed

## Context

Taskboard already exposes a loopback HTTP server and built web application, but
its embedded host behavior is coupled to Codex launcher, CDP, and authenticated
message handling. The user needs the board available from every Copilot project
session while continuing to merge upstream Taskboard updates.

Taskboard data spans SQLite, attachments, client storage, cloud configuration,
and Jira configuration. Starting multiple independent services against that
data would make service ownership ambiguous.

## Decision

Maintain an additive upstream overlay and distribute it as a user-scoped
Copilot canvas extension.

The extension owns one Taskboard service instance per extension process and data
directory, reuses it across canvas panels, and uses the existing Taskboard data.
The canvas returns the existing web application with an explicit Copilot host
identity.

Copilot host behavior uses a small Canvas host adapter and authenticated
loopback bridge. Existing Codex message and launcher behavior remains intact;
Copilot does not masquerade as Codex.

The customization fork tracks and merges the original Taskboard repository
rather than copying upstream application code into a canvas edition.

## Consequences

- Existing Taskboard data and behavior remain the source of truth.
- The canvas is available across project sessions.
- Service lifecycle and SQLite ownership have one clear owner.
- Upstream merges can conflict only at intentional host seams and adapter code.
- The extension installation must include or resolve the built web application
  and server runtime.
- Copilot-specific host capabilities can differ from Codex without weakening
  the existing Codex security boundary.
