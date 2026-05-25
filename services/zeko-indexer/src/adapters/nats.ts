import { connect } from "@nats-io/transport-node";
import { EventSchemas, NATS_SUBJECTS } from "@zeko/nats";
import { parse } from "valibot";
import type { ConsumeEnvelope } from "../types";

const textDecoder = new TextDecoder();

export const INDEXER_NATS_SUBJECTS = [
  NATS_SUBJECTS.l2Transactions,
  NATS_SUBJECTS.l2Finality,
  NATS_SUBJECTS.l1Settlements,
  NATS_SUBJECTS.l1Rollbacks,
  NATS_SUBJECTS.l1OuterActions,
  NATS_SUBJECTS.l1BridgeEvents,
  NATS_SUBJECTS.daSignatures,
] as const;

export type NatsEnvelopeSourceConfig = {
  servers: string | string[];
  subject?: string;
};

export async function* consumeNatsEnvelopes(
  config: NatsEnvelopeSourceConfig,
): AsyncGenerator<ConsumeEnvelope> {
  const connection = await connect({ servers: config.servers });
  const subscription = connection.subscribe(config.subject ?? "zeko.>");
  try {
    for await (const message of subscription) {
      const envelope = parseNatsEnvelope(message.subject, textDecoder.decode(message.data));
      if (envelope) {
        yield envelope;
      }
    }
  } finally {
    await connection.drain();
  }
}

export function parseNatsEnvelope(subject: string, data: string): ConsumeEnvelope | undefined {
  const payload = JSON.parse(data) as unknown;
  switch (subject) {
    case NATS_SUBJECTS.l2Transactions:
      return { subject, payload: parse(EventSchemas.l2Transactions, payload) };
    case NATS_SUBJECTS.l2Finality:
      return { subject, payload: parse(EventSchemas.l2Finality, payload) };
    case NATS_SUBJECTS.l1Settlements:
      return { subject, payload: parse(EventSchemas.l1Settlements, payload) };
    case NATS_SUBJECTS.l1Rollbacks:
      return { subject, payload: parse(EventSchemas.l1Rollbacks, payload) };
    case NATS_SUBJECTS.l1OuterActions:
      return { subject, payload: parse(EventSchemas.l1OuterActions, payload) };
    case NATS_SUBJECTS.l1BridgeEvents:
      return { subject, payload: parse(EventSchemas.l1BridgeEvents, payload) };
    case NATS_SUBJECTS.daSignatures:
      return { subject, payload: parse(EventSchemas.daSignatures, payload) };
    default:
      return undefined;
  }
}
