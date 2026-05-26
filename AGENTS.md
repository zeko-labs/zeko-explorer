# Agent Notes

- At the beginning of each agent session, validate the toolchain environment once: `which proto`, `proto --version`, `which moon`, and `moon --version` must resolve to the versions pinned in `.prototools`. If they do not, fix shell activation or install/sync the Proto toolchain before running project tasks. Make sure that the changes that you make stick, so that every tool call and command you run inherits the proper environment.
- Treat `docs/PRD.html` and `docs/spikes/` as source of truth; Linear issue description is never authoritative, unless explicitly told so.
- Run tool commands directly, for example `moon ci`, `pnpm install`, `node ...`, and `nu ...`. If a command only works when wrapped with `proto run`, the session environment is misconfigured; fix shell activation or install/sync the Proto toolchain so every command inherits the pinned tools from `.prototools`.
- Use Moon tasks as the command source of truth. Do not add `package.json` scripts.
- Keep tool versions in `.prototools`. Do not duplicate Node or PNPM versions in Moon toolchain config.
- Manage Go-based developer tools through Moon's Go toolchain `bins` in `.moon/toolchains.yml`; do not add custom `go install ...` scripts.
- Use PNPM catalog entries for external JavaScript dependencies.
- Use Proto-managed Nushell through `proto-nu` for local automation scripts. Do not add Bash entrypoint scripts or npm Nushell packages.
- Use Biome for linting and formatting. Do not add ESLint, Prettier, oxlint, or oxfmt.
- Use `wrangler.jsonc` and generated Wrangler Env types for Cloudflare Workers.
- Use `.kyaml` for Kubernetes values. Use `.tpl` for Helm template sources so YAML tooling only parses rendered manifests.
- Keep `apps/` for consumer surfaces and `services/` for backend services.
