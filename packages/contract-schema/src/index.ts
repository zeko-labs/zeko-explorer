import {
  array,
  type InferOutput,
  literal,
  minLength,
  minValue,
  number,
  object,
  picklist,
  pipe,
  record,
  string,
} from "valibot";

const NonEmptyString = pipe(string(), minLength(1));
const NonNegativeNumber = pipe(number(), minValue(0));

export const ContractFieldSchema = object({
  label: NonEmptyString,
  type: picklist(["field", "publicKey", "uint64", "bool", "json"]),
  index: NonNegativeNumber,
});

export const ContractSchemaDocument = object({
  version: literal(1),
  name: NonEmptyString,
  networks: pipe(array(NonEmptyString), minLength(1)),
  state: array(ContractFieldSchema),
  events: record(string(), array(ContractFieldSchema)),
  actions: record(string(), array(ContractFieldSchema)),
});

export type ContractSchemaDocument = InferOutput<typeof ContractSchemaDocument>;
