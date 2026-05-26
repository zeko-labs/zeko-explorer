export function upsertRecord(table: string, id: string, row: Record<string, unknown>): string {
  return `UPSERT ${recordId(table, id)} CONTENT ${literal(row)};`;
}

export function deleteRecord(table: string, id: string): string {
  return `DELETE ${recordId(table, id)};`;
}

export function upsertRelation(
  inTable: string,
  inId: string,
  table: string,
  outTable: string,
  outId: string,
  row: { readonly id: string } & Record<string, unknown>,
): string {
  const fields = Object.entries(row)
    .filter(([key, value]) => !RELATION_META_FIELDS.has(key) && value !== undefined)
    .map(([key, value]) => `${key}: ${literal(value)}`)
    .join(", ");
  const updates = Object.keys(row)
    .filter((key) => !RELATION_META_FIELDS.has(key) && row[key] !== undefined)
    .map((key) => `${key} = $input.${key}`)
    .join(", ");
  const onDuplicate = updates.length > 0 ? ` UPDATE ${updates}` : "";
  return `INSERT RELATION INTO ${table} { id: ${recordId(table, row.id)}, in: ${recordId(inTable, inId)}, out: ${recordId(outTable, outId)}, ${fields} } ON DUPLICATE KEY${onDuplicate} RETURN NONE;`;
}

const RELATION_META_FIELDS = new Set(["id", "in", "out"]);

export function recordId(table: string, id: string): string {
  return `${table}:hex_${Buffer.from(id, "utf8").toString("hex")}`;
}

export function record(
  table: string,
  id: string,
): { readonly kind: "record"; readonly value: string } {
  return { kind: "record", value: recordId(table, id) };
}

export function stripUndefined(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

export function date(value: string): { readonly kind: "datetime"; readonly value: string } {
  return { kind: "datetime", value };
}

export function literal(value: unknown): string {
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
      .map(([key, child]) => `${JSON.stringify(key)}: ${literal(child)}`)
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
