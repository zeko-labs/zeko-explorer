# @zeko/database

SurrealDB service workspace for the explorer read model. `surrealkit/` is the
single source for desired schema, rollout migrations, seed data, and SurrealKit
metadata. The Kubernetes chart references that project instead of carrying a
second copy.

Moon entrypoints:

- `moon run database:test` runs the Cucumber acceptance suite against a real
  SurrealDB v3 container and SurrealKit.
- `moon run database:migrate-local` reconciles a disposable local database with
  `surrealkit sync --fail-fast`.
