# Agent Notes

- Treat `docs/PRD.md` and `docs/spikes/` as source of truth; Linear issue text is context only.
- Use Moon tasks as the command source of truth. Do not add `package.json` scripts.
- Run `moon ...` directly with the Proto shim on `PATH`; do not write `proto run moon ...` into repo commands.
- Keep tool versions in `.prototools`. Do not duplicate Node or PNPM versions in Moon toolchain config.
- Use PNPM catalog entries for external JavaScript dependencies.
- Use Proto-managed Nushell through `proto-nu` for local automation scripts. Do not add Bash entrypoint scripts or npm Nushell packages.
- Use Biome for linting and formatting. Do not add ESLint, Prettier, oxlint, or oxfmt.
- Use `wrangler.jsonc` and generated Wrangler Env types for Cloudflare Workers.
- Use `.kyaml` for Kubernetes values. Use `.tpl` for Helm template sources so YAML tooling only parses rendered manifests.
- Keep `apps/` for consumer surfaces and `services/` for backend services.
