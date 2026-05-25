# @zeko/nats

Shared NATS subjects, streams, event schemas, message-id helpers, and local JetStream setup tasks for Zeko Explorer.

## Source Documents

- `docs/PRD.md`
- `docs/spikes/001-sequencer-connector/results.html`
- `docs/spikes/006-l1-watcher/addendums/nats-event-schemas.html`
- `docs/spikes/007-da-monitor/results.html`

## Exports

- `NATS_STREAMS`
- `NATS_SUBJECTS`
- `NATS_SUBJECT_TO_STREAM`
- `NATS_MESSAGE_ID`
- Valibot schemas for the L2, L1, DA signature, and health events
- TypeScript event types inferred from those schemas

## Subjects

| Domain | Subject |
| --- | --- |
| L2 transaction diffs | `zeko.l2.transactions` |
| L2 finality | `zeko.l2.finality` |
| L1 settlements | `zeko.l1.settlements` |
| L1 rollbacks | `zeko.l1.rollbacks` |
| L1 outer actions | `zeko.l1.outer-actions` |
| L1 bridge events | `zeko.l1.bridge-events` |
| Direct DA signatures | `zeko.da.signatures` |
| Health | `zeko.health` |

There is deliberately no `zeko.da.attestations` subject. Milestone 1 DA correctness is derived from `zeko.l2.finality` and `zeko.l1.settlements`.

## Local Setup

Run `moon run nats:setup-local` to create local JetStream streams.
