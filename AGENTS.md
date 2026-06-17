# Agent Notes

- At the beginning of each agent session, validate the toolchain environment once: `which proto`, `proto --version`, `which moon`, and `moon --version` must resolve to the versions pinned in `.prototools`. If they do not, fix shell activation or install/sync the Proto toolchain before running project tasks. Make sure that the changes that you make stick, so that every tool call and command you run inherits the proper environment.
- Treat `docs/PRD.html` and spike `.html` result/addendum files as the editable documentation sources of truth; Linear issue description is never authoritative unless explicitly instructed otherwise.
- Do not hand-edit generated Markdown when an HTML source exists. After editing `docs/PRD.html`, run `moon run root:sync-prd` so `docs/PRD.md` is regenerated from the HTML source.
- For spike documentation, make content changes in the canonical HTML file: `results.html` for the main spike report or `addendums/*.html` for addenda. Use `README.md` only as an index/status page that links to those HTML files.
- Run tool commands directly, for example `moon ci`, `pnpm install`, `node ...`, and `nu ...`. If a command only works when wrapped with `proto run`, the session environment is misconfigured; fix shell activation or install/sync the Proto toolchain so every command inherits the pinned tools from `.prototools`.
- Use Moon tasks as the command source of truth. Do not add `package.json` scripts.
- Keep tool versions in `.prototools`. Do not duplicate Node or PNPM versions in Moon toolchain config.
- Manage Go-based developer tools through Moon's Go toolchain `bins` in `.moon/toolchains.yml`; do not add custom `go install ...` scripts.
- Use PNPM catalog entries for external JavaScript dependencies.
- Use Proto-managed Nushell through `proto-nu` for local automation scripts. Do not add Bash entrypoint scripts or npm Nushell packages.
- Use Biome for linting and formatting. Do not add ESLint, Prettier, oxlint, or oxfmt.
- For product/domain behavior and acceptance coverage, write Gherkin feature files and run them through the repo's Vitest/Cucumber pattern, such as `@amiceli/vitest-cucumber`.
- Use extensionless relative TypeScript imports in repo code and tests. The repo uses TypeScript Bundler module resolution, so write `./foo` rather than `./foo.ts`.
- Treat TypeScript project references as Moon-managed output. The root `tsconfig.json` is the Moon-generated TypeScript solution file; fix `.moon/toolchains.yml` or project `moon.yml` dependency metadata, then run `moon sync projects` instead of hand-editing generated references.
- Use `wrangler.jsonc` and generated Wrangler Env types for Cloudflare Workers.
- Use `.kyaml` for Kubernetes values. Use `.tpl` for Helm template sources so YAML tooling only parses rendered manifests.
- Keep `apps/` for consumer surfaces and `services/` for backend services.
