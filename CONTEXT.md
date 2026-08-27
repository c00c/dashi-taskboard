# Domain Context

## Canvas host adapter

The narrow bridge between the Taskboard web application and capabilities
provided by a desktop host such as GitHub Copilot App. It carries host context
and host-only actions; it does not own board persistence or replace the
Taskboard HTTP API.

## External work provider

A provider-neutral integration that maps an external work system into
Taskboard. It owns connection and configuration, project discovery,
synchronization, external identity, lifecycle mapping, supported mutations,
external URLs, and provider errors. Jira and ADO are implementations.

## Taskboard service instance

One loopback HTTP server, SQLite connection, data directory, realtime event
source, and lifecycle owner. The user-scoped canvas extension owns one service
instance per extension process and data directory and reuses it across panels.

## Upstream overlay

The small set of canvas, host-adapter, provider, configuration, and installation
changes maintained in the customization fork. It is merged over upstream
Taskboard history and never contains a copied edition of upstream application
source.
