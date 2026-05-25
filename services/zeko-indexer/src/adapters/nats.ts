import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { EventSchemas, NATS_SUBJECTS } from "@zeko/nats";
import { parse } from "valibot";
import type { ConsumeEnvelope } from "../types.ts";

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
  stream?: string;
  durableName?: string;
  nextExpiresMs?: number;
};

export async function* consumeNatsEnvelopes(
  config: NatsEnvelopeSourceConfig,
): AsyncGenerator<ConsumeEnvelope> {
  const filterSubject = config.subject ?? "zeko.>";
  const stream = config.stream ?? streamForSubject(filterSubject);
  const durableName = config.durableName ?? "zeko-indexer";
  const connection = await connect({ servers: config.servers });
  const manager = await jetstreamManager(connection);
  await ensureDurableConsumer(manager, stream, durableName, filterSubject);
  const client = jetstream(connection);
  const consumer = await client.consumers.get(stream, durableName);
  try {
    while (true) {
      const message = await consumer.next({ expires: config.nextExpiresMs ?? 1_000 });
      if (!message) {
        continue;
      }
      const envelope = parseNatsEnvelope(message.subject, textDecoder.decode(message.data));
      if (envelope) {
        yield envelope;
      }
      message.ack();
    }
  } finally {
    await connection.close();
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

async function ensureDurableConsumer(
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
  stream: string,
  durableName: string,
  filterSubject: string,
): Promise<void> {
  try {
    await manager.consumers.info(stream, durableName);
    return;
  } catch {
    await manager.consumers.add(stream, {
      durable_name: durableName,
      name: durableName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: filterSubject,
    });
  }
}

function streamForSubject(subject: string): string {
  if (subject.startsWith("zeko.l1.")) {
    return "zeko-l1";
  }
  if (subject.startsWith("zeko.l2.")) {
    return "zeko-l2";
  }
  if (subject.startsWith("zeko.da.")) {
    return "zeko-da";
  }
  throw new Error("NATS JetStream stream is required for broad wildcard subjects");
}
