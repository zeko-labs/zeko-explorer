import type { IndexerStore } from "../store.ts";
import type {
  BridgeOperationRow,
  BridgeTransactionLinkRow,
  InnerActionRow,
  L1ActionLinkRow,
  L2ActionLinkRow,
  OuterActionRow,
} from "../types.ts";

export type SurrealHttpConfig = {
  endpoint: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
};

export type SurrealHttpClient = {
  query(sql: string): Promise<void>;
};

export function createSurrealHttpClient(config: SurrealHttpConfig): SurrealHttpClient {
  const endpoint = config.endpoint.replace(/\/$/, "");
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  return {
    async query(sql: string): Promise<void> {
      const response = await fetch(`${endpoint}/sql`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Surreal-NS": config.namespace,
          "Surreal-DB": config.database,
          Accept: "application/json",
        },
        body: sql,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`SurrealDB HTTP ${response.status}: ${text}`);
      }
      const result = JSON.parse(text) as Array<{ status: "OK" | "ERR"; result: unknown }>;
      const errors = result.filter((entry) => entry.status !== "OK");
      if (errors.length > 0) {
        throw new Error(errors.map((entry) => String(entry.result)).join("\n"));
      }
    },
  };
}

export async function writeBridgeProjectionToSurreal(
  client: SurrealHttpClient,
  store: IndexerStore,
): Promise<void> {
  const statements: string[] = [
    "DELETE bridge_transaction_link;",
    "DELETE l2_action_link;",
    "DELETE l1_action_link;",
    "DELETE outer_action;",
    "DELETE inner_action;",
    "DELETE bridge_operation;",
  ];
  for (const row of store.outerActions.values()) {
    statements.push(upsertRecord("outer_action", row.id, serializeOuterAction(row)));
  }
  for (const row of store.innerActions.values()) {
    statements.push(upsertRecord("inner_action", row.id, serializeInnerAction(row)));
  }
  for (const row of store.bridgeOperations.values()) {
    statements.push(upsertRecord("bridge_operation", row.id, serializeBridgeOperation(row)));
  }
  for (const row of store.l1ActionLinks.values()) {
    statements.push(
      upsertRelation("outer_action", row.in, "l1_action_link", "bridge_operation", row.out, row),
    );
  }
  for (const row of store.l2ActionLinks.values()) {
    statements.push(
      upsertRelation("bridge_operation", row.in, "l2_action_link", "inner_action", row.out, row),
    );
  }
  for (const row of store.bridgeTransactionLinks.values()) {
    statements.push(
      upsertRelation(
        "bridge_operation",
        row.in,
        "bridge_transaction_link",
        "transaction",
        row.out,
        row,
      ),
    );
  }
  await client.query(statements.join("\n"));
}

function serializeOuterAction(row: OuterActionRow): Record<string, unknown> {
  return stripUndefined({
    after_state: row.after_state,
    before_state: row.before_state,
    kind: row.kind,
    action_index: row.action_index,
    block_height: row.block_height,
    block_state_hash: row.block_state_hash,
    timestamp: date(row.timestamp),
    network: row.network,
    provider: row.provider,
    global_slot: row.global_slot,
    distance_from_max_block_height: row.distance_from_max_block_height,
    txn_hash: row.txn_hash,
    fields: row.fields,
    slot_range_lower: row.slot_range_lower,
    slot_range_upper: row.slot_range_upper,
    marked_as_canonical_at: row.marked_as_canonical_at
      ? date(row.marked_as_canonical_at)
      : undefined,
    ledger: row.ledger,
    inner_action_state: row.inner_action_state,
    inner_action_state_length: row.inner_action_state_length,
    synchronized_outer_action_state: row.synchronized_outer_action_state,
    synchronized_outer_action_state_length: row.synchronized_outer_action_state_length,
    aux: row.aux,
  });
}

function serializeInnerAction(row: InnerActionRow): Record<string, unknown> {
  return stripUndefined({
    after_state: row.after_state,
    before_state: row.before_state,
    action_index: row.action_index,
    block_height: row.block_height,
    timestamp: date(row.timestamp),
    txn_hash: row.txn_hash,
    transaction: row.transaction ? record("transaction", row.transaction) : undefined,
    fields: row.fields,
    aux: row.aux,
    marked_as_canonical_at: row.marked_as_canonical_at
      ? date(row.marked_as_canonical_at)
      : undefined,
    target_ledger_hash: row.target_ledger_hash,
  });
}

function serializeBridgeOperation(row: BridgeOperationRow): Record<string, unknown> {
  return stripUndefined({
    type: row.type,
    status: row.status,
    aux: row.aux,
    aux_sequence: row.aux_sequence,
    sender: row.sender,
    recipient: row.recipient,
    amount: row.amount,
    search_text: row.search_text,
    data_quality: row.data_quality,
    data_quality_reasons: row.data_quality_reasons,
    source_network: row.source_network,
    source_provider: row.source_provider,
    submit_tx_hash: row.submit_tx_hash,
    submit_block_height: row.submit_block_height,
    sort_submit_block_height: row.sort_submit_block_height,
    submit_timestamp: date(row.submit_timestamp),
    timeout_slot: row.timeout_slot,
    holder_account_l1: row.holder_account_l1,
    l1_witness_action_state: row.l1_witness_action_state,
    l1_witness_tx_hash: row.l1_witness_tx_hash,
    l1_witness_block_height: row.l1_witness_block_height,
    l1_witness_timestamp: row.l1_witness_timestamp ? date(row.l1_witness_timestamp) : undefined,
    l1_slot_range_lower: row.l1_slot_range_lower,
    l1_slot_range_upper: row.l1_slot_range_upper,
    l2_action_state: row.l2_action_state,
    l2_tx_hash: row.l2_tx_hash,
    l2_block_height: row.l2_block_height,
    l2_timestamp: row.l2_timestamp ? date(row.l2_timestamp) : undefined,
    commit_action_state: row.commit_action_state,
    cancel_tx_hash: row.cancel_tx_hash,
    rollback_reason: row.rollback_reason,
  });
}

function upsertRelation(
  inTable: string,
  inId: string,
  table: string,
  outTable: string,
  outId: string,
  row: L1ActionLinkRow | L2ActionLinkRow | BridgeTransactionLinkRow,
): string {
  return `INSERT RELATION INTO ${table} { id: ${recordId(table, row.id)}, in: ${recordId(inTable, inId)}, out: ${recordId(outTable, outId)}, role: ${literal(row.role)} } ON DUPLICATE KEY UPDATE role = $input.role RETURN NONE;`;
}

function upsertRecord(table: string, id: string, row: Record<string, unknown>): string {
  return `UPSERT ${recordId(table, id)} CONTENT ${literal(row)};`;
}

function recordId(table: string, id: string): string {
  return `${table}:${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function record(table: string, id: string): { readonly kind: "record"; readonly value: string } {
  return { kind: "record", value: recordId(table, id) };
}

function stripUndefined(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

function date(value: string): { readonly kind: "datetime"; readonly value: string } {
  return { kind: "datetime", value };
}

function literal(value: unknown): string {
  if (isDate(value)) {
    return `d"${value.value.replace(".000Z", "Z")}"`;
  }
  if (isRecordId(value)) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return `[${value.map(literal).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, child]) => `${key}: ${literal(child)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

function isDate(value: unknown): value is { readonly kind: "datetime"; readonly value: string } {
  return (
    typeof value === "object" && value !== null && "kind" in value && value.kind === "datetime"
  );
}

function isRecordId(value: unknown): value is { readonly kind: "record"; readonly value: string } {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "record";
}
