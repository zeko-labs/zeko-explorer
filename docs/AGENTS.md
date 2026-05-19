# Docs Notes

- When `PRD.html` exists, treat it as the editable PRD source and keep `PRD.md` generated beside it.
- Run `moon run docs:sync-prd` after editing `PRD.html`; CI should use `moon run docs:check-prd` to catch stale Markdown.
- Spike research lives under `docs/spikes/`; keep links relative inside `docs/`.
