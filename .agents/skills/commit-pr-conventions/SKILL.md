---
name: commit-pr-conventions
description: Use this skill when creating git commits or GitHub PRs in this repo to follow the CI Conventional Commits rules.
---

# Commit And PR Conventions

Use this skill for any task that involves creating commits or opening/updating PRs in this repo.

## Source Of Truth

The CI enforces PR title format in `/.github/workflows/verify-pr.yaml`. Keep this skill aligned with that file if it changes.

## Allowed Types

`feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `perf`, `chore`, `revert`, `release`

## Format

Use Conventional Commits:

`type(scope): summary`

- `scope` is optional and should be short, lowercase, and specific (for example `proxy`, `bridge-ui`).
- `summary` should be imperative, <= 72 chars, and without a trailing period.

## Commit Workflow

1. Ensure changes are staged.
2. Pick a type from the allowed list.
3. Write a commit message in the required format.
4. Create the commit without bypassing hooks. Do not use `--no-verify`, and do not disable Lefthook via `LEFTHOOK=0`.
5. Inspect the commit output. If the output shows Lefthook ran (for example, the `lefthook ... hook: pre-commit` banner appears), treat the hook gate as satisfied and continue. Do not run extra setup steps after a successful hook run.
6. Treat any `Can't find lefthook in PATH`, `Unable to find Lefthook`, or missing Lefthook banner as a failed commit gate. If that happens, do not push. Run `pnpm install` in the current checkout or worktree, then run:
   `pnpm exec lefthook install`
   `pnpm exec lefthook validate`
7. After the recovery steps, confirm `.git/hooks/pre-commit` exists. If it is still missing, stop and fix the hook installation before continuing.
8. Re-run `git commit` so the final commit is created with a real hook execution.
9. If the hook rewrites files (for example formatting fixes), review the resulting commit and working tree. In this repo, Lefthook-managed changes are added automatically as part of the hook flow, so do not manually re-stage those files. Only re-run `git commit` if the hook failed and no valid final commit was created.
10. Never run `git push` after a commit where the hook was skipped, disabled, failed to start, or cannot be confirmed from the commit output. Only push after a commit whose output shows the hook actually ran.
11. After every commit attempt, explicitly tell the user what happened in Lefthook. Always include whether the pre-commit hook ran, whether it rewrote files, and whether it reported warnings or errors that matter to the commit result.

## PR Workflow

1. Ensure the PR title matches the required format and allowed types.
2. If using `gh pr create --fill`, confirm the latest commit subject already matches the required format.
3. If needed, pass an explicit `--title` or update the title with `gh pr edit --title`.

## Examples

- `feat(proxy): allow all origins`
- `fix(actions-api): handle null origin`
- `chore: update tooling`
