import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const spikeDir = path.resolve(import.meta.dirname, "../..");
export const surrealKitDir = path.join(spikeDir, "surrealkit");

type QueryStatus = "OK" | "ERR";

export type SurrealResult<T = unknown> = {
  status: QueryStatus;
  time?: string;
  result: T;
};

export type RecordId = {
  readonly kind: "record";
  readonly value: string;
};

export type DateTimeLiteral = {
  readonly kind: "datetime";
  readonly value: string;
};

export type SurrealParam =
  | null
  | boolean
  | number
  | string
  | readonly SurrealParam[]
  | RecordId
  | DateTimeLiteral
  | { readonly [key: string]: SurrealParam };

let server: ChildProcessWithoutNullStreams | undefined;
let endpoint: string | undefined;
let dockerContainer: string | undefined;

export function record(value: string): RecordId {
  assert.match(value, /^[a-zA-Z_][a-zA-Z0-9_]*:[A-Za-z0-9_-]+$/);
  return { kind: "record", value };
}

export function datetime(value: string): DateTimeLiteral {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  return { kind: "datetime", value };
}

function authHeader(): string {
  return `Basic ${Buffer.from("root:root").toString("base64")}`;
}

function isRecordId(value: SurrealParam): value is RecordId {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value && value.kind === "record";
}

function isDateTimeLiteral(value: SurrealParam): value is DateTimeLiteral {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value && value.kind === "datetime";
}

function toSurrealLiteral(value: SurrealParam): string {
  if (isRecordId(value)) return value.value;
  if (isDateTimeLiteral(value)) return `d"${value.value}"`;
  if (Array.isArray(value)) return `[${value.map(toSurrealLiteral).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, child]) => `${key}: ${toSurrealLiteral(child)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

function queryParamNames(sql: string): Set<string> {
  const referenced = new Set(Array.from(sql.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g), (match) => match[1]).filter((value): value is string => value !== undefined));
  const localLets = new Set(Array.from(sql.matchAll(/\bLET\s+\$([a-zA-Z_][a-zA-Z0-9_]*)/gi), (match) => match[1]).filter((value): value is string => value !== undefined));
  for (const name of localLets) referenced.delete(name);
  return referenced;
}

export function buildLetBindings(sql: string, params: Readonly<Record<string, SurrealParam>>): string {
  const names = queryParamNames(sql);
  const bindings: string[] = [];
  for (const name of names) {
    assert.ok(Object.hasOwn(params, name), `Missing query param ${name}`);
    const value = params[name];
    assert.ok(value !== undefined, `Missing query param ${name}`);
    bindings.push(`LET $${name} = ${toSurrealLiteral(value)};`);
  }
  return bindings.join("\n");
}

export function bindSqlParams(sql: string, params: Readonly<Record<string, SurrealParam>> = {}): string {
  return `${buildLetBindings(sql, params)}\n${sql}`;
}

async function waitForServer(url: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    try {
      const response = await fetch(`${url}/sql`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Surreal-NS": "probe",
          "Surreal-DB": "probe",
          Accept: "application/json"
        },
        body: "INFO FOR DB;"
      });
      if (response.ok) return;
    } catch {
      // Keep polling until SurrealDB starts accepting HTTP queries.
    }
    await delay(250);
  }
  throw new Error("SurrealDB did not become ready");
}

export async function startSurreal(): Promise<string> {
  if (endpoint !== undefined) return endpoint;
  if (process.env.SPIKE008_SURREAL_ENDPOINT !== undefined) {
    endpoint = process.env.SPIKE008_SURREAL_ENDPOINT;
    await waitForServer(endpoint);
    return endpoint;
  }
  const port = Number(process.env.SPIKE008_SURREAL_PORT ?? 8128);
  endpoint = `http://127.0.0.1:${port}`;
  const dockerImage = process.env.SPIKE008_SURREAL_IMAGE;
  if (dockerImage === undefined) {
    server = spawn("surreal", [
      "start",
      "--no-banner",
      "--bind",
      `127.0.0.1:${port}`,
      "--username",
      "root",
      "--password",
      "root",
      "memory"
    ]);
  } else {
    dockerContainer = `spike-008-surrealdb-${process.pid}-${port}`;
    server = spawn("docker", [
      "run",
      "--rm",
      "--name",
      dockerContainer,
      "--publish",
      `127.0.0.1:${port}:8000`,
      dockerImage,
      "start",
      "--no-banner",
      "--bind",
      "0.0.0.0:8000",
      "--username",
      "root",
      "--password",
      "root",
      "memory"
    ]);
  }
  server.stderr.on("data", (chunk: Buffer) => {
    if (process.env.SPIKE008_DEBUG !== undefined) process.stderr.write(chunk);
  });
  await waitForServer(endpoint);
  return endpoint;
}

export async function stopSurreal(): Promise<void> {
  if (server === undefined) return;
  if (dockerContainer !== undefined) {
    spawn("docker", ["rm", "-f", dockerContainer], { stdio: "ignore" });
    dockerContainer = undefined;
  }
  server.kill("SIGINT");
  await delay(150);
  server = undefined;
  endpoint = undefined;
}

function surrealKitHost(): string {
  assert.ok(endpoint !== undefined, "SurrealDB server is not started");
  const url = new URL(endpoint);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

async function runProcess(command: string, args: readonly string[], options: { readonly cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (process.env.SPIKE008_DEBUG !== undefined) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (process.env.SPIKE008_DEBUG !== undefined) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function runSurrealKit(db: string, args: readonly string[], projectDir = surrealKitDir): Promise<void> {
  assert.ok(endpoint !== undefined, "SurrealDB server is not started");
  const image = process.env.SPIKE008_SURREALKIT_IMAGE ?? "ghcr.io/surrealdb/surrealkit:latest";
  await runProcess("docker", [
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${projectDir}:/work`,
    "--workdir",
    "/work",
    image,
    "--host",
    surrealKitHost(),
    "--ns",
    "spike008",
    "--db",
    db,
    "--user",
    "root",
    "--pass",
    "root",
    ...args
  ]);
}

export async function syncSchema(db: string): Promise<void> {
  await runSurrealKit(db, ["sync", "--fail-fast"]);
}

export async function applyWithSurrealKit(db: string, relativePath: string): Promise<void> {
  await runSurrealKit(db, ["apply", relativePath]);
}

export async function seedSqlWithSurrealKit(db: string, sql: string): Promise<void> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), `spike008-surrealkit-${process.pid}-`));
  await mkdir(path.join(projectDir, "database", "seed"), { recursive: true });
  await writeFile(path.join(projectDir, "surrealkit.toml"), "# Generated by spike 008 harness.\n", "utf8");
  await writeFile(path.join(projectDir, "database", "seed", "seed.surql"), sql, "utf8");
  try {
    await runSurrealKit(db, ["seed"], projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

export async function runSql<T = unknown>(db: string, sql: string, options: { readonly allowError?: boolean } = {}): Promise<SurrealResult<T>[]> {
  assert.ok(endpoint !== undefined, "SurrealDB server is not started");
  const response = await fetch(`${endpoint}/sql`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Surreal-NS": "spike008",
      "Surreal-DB": db,
      Accept: "application/json"
    },
    body: sql
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SurrealDB HTTP ${response.status}: ${text}`);
  const payload = JSON.parse(text) as SurrealResult<T>[];
  const errors = payload.filter((entry) => entry.status !== "OK");
  if (errors.length > 0 && options.allowError !== true) {
    throw new Error(errors.map((entry) => String(entry.result)).join("\n"));
  }
  return payload;
}

export async function queryFile<T = unknown>(db: string, name: string, params: Readonly<Record<string, SurrealParam>> = {}): Promise<T> {
  const sql = await readFile(path.join(spikeDir, "queries", `${name}.surql`), "utf8");
  const boundSql = bindSqlParams(sql, params);
  const result = await runSql<T>(db, boundSql);
  const last = result.at(-1);
  assert.ok(last !== undefined, `Query ${name} produced no SurrealDB response`);
  return last.result;
}
