---
name: codex-review
description: "Run Codex code review only when the user explicitly asks for code review, auto-review, autoreview, or Codex review."
---

# Codex Review

Use this skill only when the user explicitly asks for code review, auto-review,
autoreview, or Codex review. Do not trigger it merely because code was
changed.

This skill runs Codex's built-in review command as an advisory review pass. It
does not replace reading the code, running tests, or making engineering
judgment.

## Policy

- Review committed changes only: a branch against a base, or a specific commit.
- Review only commits or clean branch worktrees.
- Stay in the current branch unless the requested branch has its own existing
  worktree.
- If a different branch must be reviewed, run the review from an existing
  worktree for that branch. If no worktree exists, stop and ask the user to
  create or identify one.
- Treat review output as advisory. Verify every finding by reading the relevant
  code path and adjacent files.
- Accept real issues at priorities `P0` through `P3`.
- Reject speculative findings, unrealistic edge cases, broad rewrites, and fixes
  that over-complicate the codebase.
- If a review finding leads to code changes, rerun focused tests and rerun review
  until no accepted/actionable findings remain.
- Do not push, create a branch, or create a PR unless the user separately asks.

## Targets

Branch review:

```bash
.agents/skills/codex-review/scripts/codex-review --mode branch
```

Specific branch review:

```bash
.agents/skills/codex-review/scripts/codex-review --mode branch --branch <branch>
```

Specific commit review:

```bash
.agents/skills/codex-review/scripts/codex-review --mode commit --commit <ref>
```

If an open PR exists, the helper uses its actual base branch. Otherwise it uses
`origin/main` unless `--base` is provided.

## Parallel Closeout

When useful, run review and focused tests together:

```bash
.agents/skills/codex-review/scripts/codex-review --parallel-tests "<focused test command>"
```

If tests or review require fixes, rerun the affected tests and rerun review.

## Final Report

Include:

- review command used
- tests or proof run
- findings accepted or rejected, with brief reasons
- final clean review result, or the reason a remaining finding was consciously
  rejected
