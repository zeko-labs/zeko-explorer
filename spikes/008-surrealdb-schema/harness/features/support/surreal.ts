import { mkdir } from "node:fs/promises";
import path from "node:path";
import { After, AfterAll, Before, BeforeAll, setWorldConstructor, type ITestCaseHookParameter, World } from "@cucumber/cucumber";
import { applyFile, queryFile, runSql, spikeDir, startSurreal, stopSurreal, type SurrealParam } from "../../lib/surreal-client.ts";

export { applyFile, queryFile, runSql, spikeDir, startSurreal, stopSurreal };
export type Row = Record<string, unknown>;

export class SpikeWorld extends World {
  db = "";
  lastResult: Row[] = [];
  lastError: unknown;
}

setWorldConstructor(SpikeWorld);

BeforeAll(async function (): Promise<void> {
  await mkdir(path.join(spikeDir, "harness", "reports"), { recursive: true });
  await startSurreal();
});

AfterAll(async function (): Promise<void> {
  await stopSurreal();
});

Before(function (this: SpikeWorld, { pickle }: ITestCaseHookParameter): void {
  const suffix = pickle.id.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
  this.db = `scenario_${Date.now()}_${suffix}`;
  this.lastResult = [];
  this.lastError = undefined;
});

After(function (): void {
  // Each scenario uses a unique in-memory database name. Leaving it in place
  // avoids coupling tests to namespace-level destructive commands.
});

export function parseParam(value: string): SurrealParam {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*:[A-Za-z0-9_-]+$/.test(value)) {
    return { kind: "record", value };
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1);
  return value;
}
