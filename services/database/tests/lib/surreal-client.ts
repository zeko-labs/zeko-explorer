import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import databaseImages from "../../database-images.json" with { type: "json" };

export const serviceDir = path.resolve(import.meta.dirname, "../..");
export const surrealKitDir = path.join(serviceDir, "surrealkit");
const surrealNamespace = "database_test";

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

export function parseParam(value: string): SurrealParam {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*:[A-Za-z0-9_-]+$/.test(value)) {
    return { kind: "record", value };
  }
  const parsedDatetime = value.match(/^d"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"$/);
  if (parsedDatetime?.[1] !== undefined) {
    return { kind: "datetime", value: parsedDatetime[1] };
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function authHeader(): string {
  return `Basic ${Buffer.from("root:root").toString("base64")}`;
}

function isRecordId(value: SurrealParam): value is RecordId {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "record"
  );
}

function isDateTimeLiteral(value: SurrealParam): value is DateTimeLiteral {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "datetime"
  );
}

function toSurrealLiteral(value: SurrealParam): string {
  if (isRecordId(value)) return value.value;
  if (isDateTimeLiteral(value)) return `d"${value.value}"`;
  if (Array.isArray(value)) return `[${value.map(toSurrealLiteral).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, child]) => `${key}: ${toSurrealLiteral(child)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

function queryParamNames(surql: string): Set<string> {
  const referenced = new Set(
    Array.from(surql.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g), (match) => match[1]).filter(
      (value): value is string => value !== undefined,
    ),
  );
  const localLets = new Set(
    Array.from(surql.matchAll(/\bLET\s+\$([a-zA-Z_][a-zA-Z0-9_]*)/gi), (match) => match[1]).filter(
      (value): value is string => value !== undefined,
    ),
  );
  for (const name of localLets) referenced.delete(name);
  return referenced;
}

export function buildLetBindings(
  surql: string,
  params: Readonly<Record<string, SurrealParam>>,
): string {
  const names = queryParamNames(surql);
  const bindings: string[] = [];
  for (const name of names) {
    assert.ok(Object.hasOwn(params, name), `Missing query param ${name}`);
    const value = params[name];
    assert.ok(value !== undefined, `Missing query param ${name}`);
    bindings.push(`LET $${name} = ${toSurrealLiteral(value)};`);
  }
  return bindings.join("\n");
}

export function bindSurqlParams(
  surql: string,
  params: Readonly<Record<string, SurrealParam>> = {},
): string {
  return `${buildLetBindings(surql, params)}\n${surql}`;
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
          Accept: "application/json",
        },
        body: "INFO FOR DB;",
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
  if (process.env.DATABASE_TEST_SURREAL_ENDPOINT !== undefined) {
    endpoint = process.env.DATABASE_TEST_SURREAL_ENDPOINT;
    await waitForServer(endpoint);
    return endpoint;
  }
  const port = Number(process.env.DATABASE_TEST_SURREAL_PORT ?? 8128);
  endpoint = `http://127.0.0.1:${port}`;
  const dockerImage = process.env.DATABASE_TEST_SURREAL_IMAGE ?? databaseImages.surrealdb;
  dockerContainer = `zeko-database-test-${process.pid}-${port}`;
  server = spawn("docker", [
    "run",
    "--rm",
    "--name",
    dockerContainer,
    "--publish",
    `${port}:8000`,
    dockerImage,
    "start",
    "--no-banner",
    "--bind",
    "0.0.0.0:8000",
    "--username",
    "root",
    "--password",
    "root",
    "memory",
  ]);
  server.stderr.on("data", (chunk: Buffer) => {
    if (process.env.DATABASE_TEST_DEBUG !== undefined) process.stderr.write(chunk);
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
  if (process.env.DATABASE_TEST_SURREALKIT_HOST !== undefined) {
    return process.env.DATABASE_TEST_SURREALKIT_HOST.replace(/\/$/, "");
  }
  assert.ok(endpoint !== undefined, "SurrealDB server is not started");
  const url = new URL(endpoint);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (process.env.DATABASE_TEST_DEBUG !== undefined) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (process.env.DATABASE_TEST_DEBUG !== undefined) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}

async function runSurrealKit(
  db: string,
  args: readonly string[],
  projectDir = surrealKitDir,
): Promise<void> {
  assert.ok(endpoint !== undefined, "SurrealDB server is not started");
  const image = process.env.SURREALKIT_IMAGE ?? databaseImages.surrealkit;
  const copiedProjectDir =
    projectDir === surrealKitDir ? await writableProjectCopy(projectDir) : undefined;
  const workDir = copiedProjectDir ?? projectDir;
  await chmodRecursive(workDir);
  try {
    await runProcess("docker", [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${workDir}:/work`,
      "--workdir",
      "/work",
      "--env",
      "SURREALDB_FOLDER=/work/database",
      image,
      "--host",
      surrealKitHost(),
      "--ns",
      surrealNamespace,
      "--db",
      db,
      "--user",
      "root",
      "--pass",
      "root",
      ...args,
    ]);
  } finally {
    if (copiedProjectDir !== undefined) {
      await rm(copiedProjectDir, { recursive: true, force: true });
    }
  }
}

async function writableProjectCopy(projectDir: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `zeko-surrealkit-${process.pid}-`));
  await cp(projectDir, tempDir, { recursive: true });
  return tempDir;
}

async function chmodRecursive(dir: string): Promise<void> {
  await chmod(dir, 0o777);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmodRecursive(entryPath);
    } else {
      await chmod(entryPath, 0o666);
    }
  }
}

export async function syncSchema(db: string): Promise<void> {
  await runSurrealKit(db, ["sync", "--fail-fast"]);
}

export async function seedSurqlWithSurrealKit(db: string, surql: string): Promise<void> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), `spike008-surrealkit-${process.pid}-`));
  await mkdir(path.join(projectDir, "database", "seed"), { recursive: true });
  await writeFile(
    path.join(projectDir, "surrealkit.toml"),
    "# Generated by spike 008 harness.\n",
    "utf8",
  );
  await writeFile(path.join(projectDir, "database", "seed", "seed.surql"), surql, "utf8");
  try {
    await runSurrealKit(db, ["seed"], projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

export async function runSurql<T = unknown>(
  db: string,
  surql: string,
  options: { readonly allowError?: boolean } = {},
): Promise<SurrealResult<T>[]> {
  assert.ok(endpoint !== undefined, "SurrealDB server is not started");
  const response = await fetch(`${endpoint}/sql`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Surreal-NS": surrealNamespace,
      "Surreal-DB": db,
      Accept: "application/json",
    },
    body: surql,
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

export async function queryFile<T = unknown>(
  db: string,
  name: string,
  params: Readonly<Record<string, SurrealParam>> = {},
): Promise<T> {
  const surql = await readFile(path.join(serviceDir, "queries", `${name}.surql`), "utf8");
  const boundSurql = bindSurqlParams(surql, params);
  const result = await runSurql<T>(db, boundSurql);
  const last = result.at(-1);
  assert.ok(last !== undefined, `Query ${name} produced no SurrealDB response`);
  return last.result;
}
