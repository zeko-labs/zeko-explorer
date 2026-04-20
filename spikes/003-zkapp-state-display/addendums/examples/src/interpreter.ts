import { Field, PublicKey, UInt32, UInt64, Bool } from "o1js";
import {
  isPrimitive,
  widthOf,
  isDiscriminated,
  isSingleShape,
  type Slot,
  type StructDef,
  type Submission,
  type Variants,
} from "./schema.ts";

type Types = Record<string, StructDef>;

function readAt(raw: string[], at: number): string {
  const v = raw[at];
  if (v === undefined) throw new Error(`raw[${at}] is out of bounds (length=${raw.length})`);
  return v;
}

function decodePrimitive(type: string, raw: string[], at: number): unknown {
  switch (type) {
    case "Field":
      return Field.from(readAt(raw, at)).toString();
    case "UInt32":
      return UInt32.from(readAt(raw, at)).toString();
    case "UInt64":
      return UInt64.from(readAt(raw, at)).toString();
    case "Bool":
      return Bool(readAt(raw, at) === "1").toBoolean();
    case "PublicKey":
      return PublicKey.fromFields([Field.from(readAt(raw, at)), Field.from(readAt(raw, at + 1))]).toBase58();
    default:
      throw new Error(`unknown primitive: ${type}`);
  }
}

function decodeAt(type: string, raw: string[], at: number, types: Types): unknown {
  if (isPrimitive(type)) return decodePrimitive(type, raw, at);
  const struct = types[type];
  if (!struct) throw new Error(`unknown type: ${type}`);
  const out: Record<string, unknown> = {};
  let cursor = at;
  for (const field of struct.fields) {
    out[field.name] = decodeAt(field.type, raw, cursor, types);
    cursor += widthOf(field.type, types);
  }
  return out;
}

function decodeSlots(slots: Slot[], raw: string[], types: Types): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const slot of slots) {
    const w = widthOf(slot.type, types);
    if (slot.at + w > raw.length) {
      throw new Error(`slot "${slot.name}" reads past raw length (at=${slot.at}, width=${w}, raw=${raw.length})`);
    }
    out[slot.name] = decodeAt(slot.type, raw, slot.at, types);
  }
  return out;
}

export function decodeState(submission: Submission, raw: string[]): Record<string, unknown> {
  if (raw.length !== 8) throw new Error(`state must have exactly 8 fields, got ${raw.length}`);
  return decodeSlots(submission.state.slots, raw, submission.types ?? {});
}

export function decodeEventOrAction(
  variants: Variants,
  raw: string[],
  types: Types = {},
): Record<string, unknown> | null {
  if (variants === null) return null;
  if (isSingleShape(variants)) return decodeSlots(variants.fields, raw, types);
  if (isDiscriminated(variants)) {
    const disc = readAt(raw, variants.discriminator.at);
    const match = variants.variants.find((v) => v.when === disc);
    if (!match) return null;
    return { kind: match.kind, ...decodeSlots(match.fields, raw, types) };
  }
  return null;
}
