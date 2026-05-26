import type { BridgeOperationRow } from "./types.ts";

const inactiveStatuses: ReadonlySet<BridgeOperationRow["status"]> = new Set([
  "rolled_back",
  "cancelled",
  "timed_out",
]);

const depositTerminalStatuses: ReadonlySet<BridgeOperationRow["status"]> = new Set([
  "rolled_back",
  "cancelled",
  "timed_out",
]);

const uncancellableDepositStatuses: ReadonlySet<BridgeOperationRow["status"]> = new Set([
  "rolled_back",
  "cancelled",
  "completed",
]);

export function isActiveBridgeOperation(operation: BridgeOperationRow): boolean {
  return !inactiveStatuses.has(operation.status);
}

export function isActiveDeposit(operation: BridgeOperationRow): boolean {
  return operation.type === "deposit" && isActiveBridgeOperation(operation);
}

export function isCancellableDeposit(operation: BridgeOperationRow): boolean {
  return operation.type === "deposit" && !uncancellableDepositStatuses.has(operation.status);
}

export function depositStatus(operation: BridgeOperationRow): BridgeOperationRow["status"] {
  if (depositTerminalStatuses.has(operation.status)) {
    return operation.status;
  }
  if (!operation.l1_witness_action_state) {
    return "submitted";
  }
  if (operation.l2_action_state && operation.commit_action_state) {
    return "completed";
  }
  if (operation.commit_action_state) {
    return "committed";
  }
  return "l1_witnessed";
}

export function withdrawalStatus(operation: BridgeOperationRow): BridgeOperationRow["status"] {
  if (operation.status === "rolled_back" || operation.status === "cancelled") {
    return operation.status;
  }
  if (operation.l1_witness_action_state || operation.l1_witness_tx_hash) {
    return "completed";
  }
  if (operation.commit_action_state) {
    return "committed";
  }
  if (operation.l2_action_state) {
    return "l2_witnessed";
  }
  return "submitted";
}

export function withdrawalRollbackStatus(
  operation: BridgeOperationRow,
): BridgeOperationRow["status"] {
  if (operation.l1_witness_action_state || operation.l1_witness_tx_hash) {
    return "completed";
  }
  if (operation.commit_action_state) {
    return "committed";
  }
  if (operation.l2_action_state) {
    return "l2_witnessed";
  }
  return "rolled_back";
}
