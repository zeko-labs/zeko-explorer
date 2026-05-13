import { z } from "zod";

export const ContractFieldSchema = z.object({
  label: z.string().min(1),
  type: z.enum(["field", "publicKey", "uint64", "bool", "json"]),
  index: z.number().int().nonnegative(),
});

export const ContractSchemaDocument = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  networks: z.array(z.string().min(1)).min(1),
  state: z.array(ContractFieldSchema),
  events: z.record(z.array(ContractFieldSchema)).default({}),
  actions: z.record(z.array(ContractFieldSchema)).default({}),
});

export type ContractSchemaDocument = z.infer<typeof ContractSchemaDocument>;
