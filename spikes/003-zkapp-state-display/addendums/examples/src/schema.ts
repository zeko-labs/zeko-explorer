export const SCHEMA_VERSION = 1 as const;

export type Primitive = "Field" | "UInt32" | "UInt64" | "Bool" | "PublicKey";

export type Slot = { at: number; name: string; type: string };
export type StructDef = { fields: { name: string; type: string }[] };

export type SingleShape = { fields: Slot[] };
export type DiscriminatedShape = {
  discriminator: { at: number };
  variants: { when: string; kind: string; fields: Slot[] }[];
};
export type Variants = null | SingleShape | DiscriminatedShape;

export type Network = "zeko-m-devnet" | "zeko-mainnet";

export type Submission = {
  $schema?: string;
  version: 1;
  meta: {
    address: string;
    networks: Network[];
    name: string;
    description?: string;
    source?: { repo: string; commit: string };
    vkeyHash?: string;
  };
  types?: Record<string, StructDef>;
  state: { slots: Slot[] };
  events?: Variants;
  actions?: Variants;
  owner?: { address: string; signature: { r: string; s: string } };
};

export type Fixture = {
  target: "state" | "event" | "action";
  raw: string[];
  expected: unknown;
};

export type FixtureFile = { fixtures: Fixture[] };

export const PRIMITIVE_WIDTH: Record<Primitive, number> = {
  Field: 1,
  UInt32: 1,
  UInt64: 1,
  Bool: 1,
  PublicKey: 2,
};

export function isPrimitive(t: string): t is Primitive {
  return t in PRIMITIVE_WIDTH;
}

export function widthOf(type: string, types: Record<string, StructDef> = {}): number {
  if (isPrimitive(type)) return PRIMITIVE_WIDTH[type];
  const s = types[type];
  if (!s) throw new Error(`unknown type: ${type}`);
  return s.fields.reduce((acc, f) => acc + widthOf(f.type, types), 0);
}

export function isDiscriminated(v: Variants): v is DiscriminatedShape {
  return v !== null && "variants" in v;
}

export function isSingleShape(v: Variants): v is SingleShape {
  return v !== null && "fields" in v;
}
