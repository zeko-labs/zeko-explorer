# Zeko Explorer

Zeko Explorer is a Moon-managed monorepo for the Zeko explorer applications,
workers, services, shared packages, and local infrastructure.

## Prerequisites

- [proto](https://moonrepo.dev/proto) for pinned tool versions
- Docker for local images and integration services
- Kubernetes tooling when working with the local infrastructure tasks

Tool versions are declared in `.prototools`. Proto shims resolve those pinned
tools from `PATH`, and Moon's toolchain setup installs the required tools
automatically in CI.

## Setup

```sh
proto install
pnpm install
```

## Common Commands

```sh
moon ci --summary normal
moon run :lint
moon run :format
moon run :typecheck
moon run ui:dev
```

Moon projects and tasks are defined in `moon.yml`, `.moon/tasks/*.yml`, and each
project's `moon.yml`.
