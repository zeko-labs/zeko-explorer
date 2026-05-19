# Docs Notes

- When `PRD.html` exists, treat it as the editable PRD source and keep `PRD.md` generated beside it.
- Run `node scripts/docs/sync-prd.ts` from the repository root after editing `docs/PRD.html`; CI checks the same conversion with `--check`.
- Spike research lives under `docs/spikes/`; keep links relative inside `docs/`.
