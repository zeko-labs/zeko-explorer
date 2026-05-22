# Agent Notes

- Treat `docs/PRD.md` and `docs/spikes/` as source of truth; Linear issue text is context only.
- Use Moon tasks as the command source of truth. Do not add `package.json` scripts.
- Run tool commands directly through the Proto shims on `PATH`, for example `moon ci`, `pnpm install`, `node ...`, and `nu ...`. Do not wrap commands with `proto run ...` during normal local or CI work; if a shim is missing, install or sync the toolchain instead of changing the command shape.
- Keep tool versions in `.prototools`. Do not duplicate Node or PNPM versions in Moon toolchain config.
- Manage Go-based developer tools through Moon's Go toolchain `bins` in `.moon/toolchains.yml`; do not add custom `go install ...` scripts.
- Use PNPM catalog entries for external JavaScript dependencies.
- Use Proto-managed Nushell through `proto-nu` for local automation scripts. Do not add Bash entrypoint scripts or npm Nushell packages.
- Use Biome for linting and formatting. Do not add ESLint, Prettier, oxlint, or oxfmt.
- Use `wrangler.jsonc` and generated Wrangler Env types for Cloudflare Workers.
- Use `.kyaml` for Kubernetes values. Use `.tpl` for Helm template sources so YAML tooling only parses rendered manifests.
- Keep `apps/` for consumer surfaces and `services/` for backend services.
