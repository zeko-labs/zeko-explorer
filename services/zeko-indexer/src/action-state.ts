import { Field, Poseidon } from "o1js";

const MINA_ZKAPP_ACTIONS_PREFIX = "MinaZkappActions*******";

export function deriveZkappActionState(
  beforeActionState: string,
  fields: readonly string[],
): string {
  const before = Field(beforeActionState);
  const actionCommitment = Poseidon.hashWithPrefix(
    MINA_ZKAPP_ACTIONS_PREFIX,
    fields.map((field) => Field(field)),
  );
  return Poseidon.hash([before, actionCommitment]).toString();
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
