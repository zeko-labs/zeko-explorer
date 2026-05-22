# Zeko Explorer

Zeko Explorer is a Moon-managed monorepo for the Zeko explorer applications,
workers, services, shared packages, and local infrastructure.

## Prerequisites

- [proto](https://moonrepo.dev/proto) for pinned tool versions
- Docker for local images and integration services
- Kubernetes tooling when working with the local infrastructure tasks

Tool versions are declared in `.prototools`. Moon's toolchain setup installs the
required tools automatically in CI, and locally you can run commands through
`proto run` if a tool is not already on your `PATH`.

## Setup

```sh
proto install
proto run pnpm -- install
```

## Common Commands

```sh
proto run moon -- ci --summary normal
proto run moon -- run :lint
proto run moon -- run :format
proto run moon -- run :typecheck
proto run moon -- run ui:dev
```

Moon projects and tasks are defined in `moon.yml`, `.moon/tasks/*.yml`, and each
project's `moon.yml`.
