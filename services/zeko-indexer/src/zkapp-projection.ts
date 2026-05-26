import {
  EMPTY_ZKAPP_ACTION_STATE,
  isZkappFieldElement,
  tryDeriveZkappActionState,
} from "./action-state.ts";
import { consumeBridgeInnerAction } from "./bridge.ts";
import type { ZekoIndexerState } from "./indexer-state.ts";
import {
  arrayValue,
  isRecord,
  nestedArrayValue,
  nestedStringValue,
  stringValue,
} from "./indexer-utils.ts";
import { accountKey } from "./store.ts";
import type {
  L2AccountChangeInput,
  L2TransactionInput,
  ObservedZkappActionInput,
  TransactionRow,
} from "./types.ts";

export function assertNewZkappActionStates(
  state: ZekoIndexerState,
  event: L2TransactionInput,
): void {
  if (event.command?.type !== "zkapp_command") {
    return;
  }

  const existingActionStates = new Set<string>();
  for (const action of state.store.zkappActions.values()) {
    existingActionStates.add(action.action_state);
  }
  const incomingActionStates = new Set<string>();
  for (const update of event.command.account_updates ?? []) {
    const publicKey = accountUpdatePublicKey(update);
    if (!publicKey) {
      continue;
    }
    const changedAccount = accountUpdateChangedAccount(event, update, publicKey);
    const tokenId = accountUpdateTokenId(update) ?? changedAccount?.account.token_id ?? "1";
    const actions = normalizeObservedActions(accountUpdateActions(update), {
      beforeHead: state.store.accountByPublicKey(publicKey, tokenId)?.action_state?.[0],
      afterHeads: changedAccount?.account.action_state,
    });
    for (const action of actions) {
      if (
        existingActionStates.has(action.action_state) ||
        incomingActionStates.has(action.action_state)
      ) {
        throw new Error(`Duplicate zkApp action_state ${action.action_state}`);
      }
      incomingActionStates.add(action.action_state);
    }
  }
}

export function writeZkappChildren(
  state: ZekoIndexerState,
  event: L2TransactionInput,
  transaction: TransactionRow,
): void {
  const updates = event.command?.account_updates ?? [];
  const eventIndexesByAccount = new Map<string, number>();
  const actionIndexesByAccount = new Map<string, number>();
  for (const update of updates) {
    const publicKey = accountUpdatePublicKey(update);
    if (!publicKey) {
      continue;
    }
    const changedAccount = accountUpdateChangedAccount(event, update, publicKey);
    const tokenId = accountUpdateTokenId(update) ?? changedAccount?.account.token_id ?? "1";
    const account = state.store.accountByPublicKey(publicKey, tokenId);
    if (!account) {
      continue;
    }
    const accountIndexKey = accountKey(publicKey, tokenId);
    const activity = [...state.store.accountActivities.values()].find(
      (candidate) => candidate.transaction === transaction.id && candidate.account === account.id,
    );
    const events = normalizeFieldArrays(accountUpdateEvents(update));
    events.forEach((fields) => {
      const eventIndex = eventIndexesByAccount.get(accountIndexKey) ?? 0;
      eventIndexesByAccount.set(accountIndexKey, eventIndex + 1);
      const key = `${transaction.id}:${publicKey}:${tokenId}:event:${eventIndex}`;
      if (state.store.zkappEvents.has(key)) {
        return;
      }
      state.store.zkappEvents.set(key, {
        id: state.store.idFactory.newId(transaction.timestamp, `zkapp_event:${key}`),
        transaction: transaction.id,
        transaction_hash: transaction.hash,
        emitting_account: account.id,
        emitting_account_public_key: publicKey,
        event_index: eventIndex,
        block_height: transaction.block_height,
        tx_index: transaction.tx_index,
        sort_block_height: transaction.sort_block_height,
        sort_tx_index: transaction.sort_tx_index,
        sort_event_index: eventIndex,
        timestamp: transaction.timestamp,
        fields,
        sequence_number: state.store.nextEventSequence(),
        target_ledger_hash: event.target_ledger_hash,
      });
    });

    const actions = normalizeObservedActions(accountUpdateActions(update), {
      beforeHead: activity?.action_state_before?.[0],
      afterHeads: activity?.action_state_after,
    });
    actions.forEach((action) => {
      const actionIndex = actionIndexesByAccount.get(accountIndexKey) ?? 0;
      actionIndexesByAccount.set(accountIndexKey, actionIndex + 1);
      const key = `${transaction.id}:${publicKey}:${tokenId}:action:${actionIndex}`;
      if (state.store.zkappActions.has(key)) {
        return;
      }
      state.store.zkappActions.set(key, {
        id: state.store.idFactory.newId(transaction.timestamp, `zkapp_action:${key}`),
        transaction: transaction.id,
        transaction_hash: transaction.hash,
        emitting_account: account.id,
        emitting_account_public_key: publicKey,
        action_index: actionIndex,
        block_height: transaction.block_height,
        tx_index: transaction.tx_index,
        sort_block_height: transaction.sort_block_height,
        sort_tx_index: transaction.sort_tx_index,
        sort_action_index: actionIndex,
        timestamp: transaction.timestamp,
        fields: action.fields,
        before_action_state: action.before_action_state,
        action_state: action.action_state,
        sequence_number: state.store.nextActionSequence(),
        target_ledger_hash: event.target_ledger_hash,
      });
      const actionRow = state.store.zkappActions.get(key);
      if (actionRow && isBridgeInnerAction(state, publicKey)) {
        consumeBridgeInnerAction(state.store, transaction, actionRow);
      }
    });
  }
}

function isBridgeInnerAction(state: ZekoIndexerState, publicKey: string): boolean {
  const configured = state.options.bridge?.innerActionPublicKeys;
  if (!configured) {
    return false;
  }
  return configured.has(publicKey);
}

const accountUpdatePublicKey = (update: unknown): string | undefined => {
  if (!isRecord(update)) {
    return undefined;
  }
  return (
    stringValue(update.public_key) ??
    nestedStringValue(update.account, "public_key") ??
    nestedStringValue(update.body, "public_key")
  );
};

const accountUpdateTokenId = (update: unknown): string | undefined => {
  if (!isRecord(update)) {
    return undefined;
  }
  return (
    stringValue(update.token_id) ??
    nestedStringValue(update.account, "token_id") ??
    nestedStringValue(update.body, "token_id")
  );
};

const accountUpdateEvents = (update: unknown): unknown[] => {
  if (!isRecord(update)) {
    return [];
  }
  return arrayValue(update.events) ?? nestedArrayValue(update.body, "events") ?? [];
};

const accountUpdateActions = (update: unknown): unknown[] => {
  if (!isRecord(update)) {
    return [];
  }
  return arrayValue(update.actions) ?? nestedArrayValue(update.body, "actions") ?? [];
};

const accountUpdateChangedAccount = (
  event: L2TransactionInput,
  update: unknown,
  publicKey: string,
): L2AccountChangeInput | undefined => {
  const matches = event.changed_accounts.filter(
    (change) => change.account.public_key === publicKey,
  );
  const tokenId = accountUpdateTokenId(update);
  if (tokenId) {
    return matches.find((change) => (change.account.token_id ?? "1") === tokenId);
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return matches.find((change) => (change.account.token_id ?? "1") === "1");
};

const normalizeFieldArrays = (items: unknown[]): string[][] =>
  items.flatMap((item) => {
    if (Array.isArray(item)) {
      return [item.map(String)];
    }
    if (isRecord(item) && Array.isArray(item.fields)) {
      return [item.fields.map(String)];
    }
    return [];
  });

type ActionStateContext = {
  beforeHead?: string;
  afterHeads?: string[];
};

const normalizeObservedActions = (
  items: unknown[],
  state: ActionStateContext = {},
): ObservedZkappActionInput[] => {
  const observed: ObservedZkappActionInput[] = [];
  let cursor = state.beforeHead ?? EMPTY_ZKAPP_ACTION_STATE;

  items.forEach((item, index) => {
    const rawFields = rawActionFields(item);
    if (rawFields) {
      const knownAfter = actionStateAfter(index, items.length, state);
      const derivedAfter = tryDeriveZkappActionState(cursor, rawFields);
      if (
        knownAfter &&
        isZkappFieldElement(knownAfter) &&
        derivedAfter &&
        knownAfter !== derivedAfter
      ) {
        throw new Error(
          `Computed zkApp action_state does not match post-state vector at index ${index}`,
        );
      }
      const after = knownAfter ?? derivedAfter;
      if (!after) {
        throw new Error("Cannot index raw zkApp action without action_state snapshots");
      }
      observed.push({
        fields: rawFields,
        before_action_state: cursor,
        action_state: after,
      });
      cursor = after;
      return;
    }
    if (!isRecord(item) || !Array.isArray(item.fields)) {
      return;
    }
    if (typeof item.before_action_state !== "string" || typeof item.action_state !== "string") {
      return;
    }
    const action = {
      fields: item.fields.map(String),
      before_action_state: item.before_action_state,
      action_state: item.action_state,
    };
    observed.push(action);
    cursor = action.action_state;
  });

  return observed;
};

const rawActionFields = (item: unknown): string[] | undefined => {
  if (Array.isArray(item)) {
    return item.map(String);
  }
  if (
    isRecord(item) &&
    Array.isArray(item.fields) &&
    (typeof item.before_action_state !== "string" || typeof item.action_state !== "string")
  ) {
    return item.fields.map(String);
  }
  return undefined;
};

const actionStateAfter = (
  actionIndex: number,
  actionCount: number,
  state: ActionStateContext,
): string | undefined => state.afterHeads?.[actionCount - actionIndex - 1];
