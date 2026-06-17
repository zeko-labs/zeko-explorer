# Docs Notes

- When `PRD.html` exists, treat it as the editable PRD source and keep `PRD.md` generated beside it.
- Run `moon run root:sync-prd` from the repository root after editing `docs/PRD.html`; `moon ci` runs `root:check-prd` to catch stale Markdown.
- Spike research lives under `docs/spikes/`; `results.html` and `addendums/*.html` are the editable source of truth for spike report and addendum content. Use spike `README.md` files only as index/status pages that link to those HTML files.
- Keep links relative inside `docs/`.
