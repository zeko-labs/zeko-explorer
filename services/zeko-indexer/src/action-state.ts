import { AccountUpdate, Field } from "o1js";

export const EMPTY_ZKAPP_ACTION_STATE = AccountUpdate.Actions.emptyActionState().toString();

export function deriveZkappActionState(
  beforeActionState: string,
  fields: readonly string[],
): string {
  const before = Field(beforeActionState);
  const actionHash = AccountUpdate.Actions.hash([fields.map((field) => Field(field))]);
  return AccountUpdate.Actions.updateSequenceState(before, actionHash).toString();
}

export function tryDeriveZkappActionState(
  beforeActionState: string,
  fields: readonly string[],
): string | undefined {
  try {
    return deriveZkappActionState(beforeActionState, fields);
  } catch {
    return undefined;
  }
}

export function isZkappFieldElement(value: string): boolean {
  try {
    Field(value);
    return true;
  } catch {
    return false;
  }
}
