import {
  After,
  AfterAll,
  Before,
  BeforeAll,
  setDefaultTimeout,
  setWorldConstructor,
  type ITestCaseHookParameter,
  World,
} from "@cucumber/cucumber";
import {
  applyWithSurrealKit,
  queryFile,
  runSql,
  startSurreal,
  stopSurreal,
  syncSchema,
  syncSpike008Schema,
  type SurrealParam,
} from "../lib/surreal-client.ts";

export {
  applyWithSurrealKit,
  queryFile,
  runSql,
  startSurreal,
  stopSurreal,
  syncSchema,
  syncSpike008Schema,
};
export type Row = Record<string, unknown>;

export class SpikeWorld extends World {
  db = "";
  lastResult: Row[] = [];
  lastError: unknown;
}

setWorldConstructor(SpikeWorld);
setDefaultTimeout(60_000);

BeforeAll(async (): Promise<void> => {
  await startSurreal();
});

AfterAll(async (): Promise<void> => {
  await stopSurreal();
});

Before(function (this: SpikeWorld, { pickle }: ITestCaseHookParameter): void {
  const suffix = pickle.id.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
  this.db = `scenario_${Date.now()}_${suffix}`;
  this.lastResult = [];
  this.lastError = undefined;
});

After((): void => {
  // Each scenario uses a unique in-memory database name. Leaving it in place
  // avoids coupling tests to namespace-level destructive commands.
});

export function parseParam(value: string): SurrealParam {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*:[A-Za-z0-9_-]+$/.test(value)) {
    return { kind: "record", value };
  }
  const datetime = value.match(/^d"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"$/);
  if (datetime?.[1] !== undefined) return { kind: "datetime", value: datetime[1] };
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}
