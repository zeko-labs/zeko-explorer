import {
  widthOf,
  isDiscriminated,
  isSingleShape,
  type Submission,
  type FixtureFile,
  type Fixture,
} from "./schema.ts";
import { validateSubmission } from "./validate.ts";
import { decodeState, decodeEventOrAction } from "./interpreter.ts";
import { verifySubmission } from "./signature.ts";
import { resolve } from "node:path";

type Grade = "owner-signed" | "source-linked" | "community-submitted";

function semanticChecks(sub: Submission): string[] {
  const errs: string[] = [];
  const types = sub.types ?? {};
  for (const slot of sub.state.slots) {
    let w: number;
    try {
      w = widthOf(slot.type, types);
    } catch (e) {
      errs.push(`state slot "${slot.name}": ${(e as Error).message}`);
      continue;
    }
    const end = slot.at + w;
    if (end > 8) errs.push(`state slot "${slot.name}" spans [${slot.at}, ${end}] which exceeds 8`);
  }
  const checkVariants = (key: "events" | "actions") => {
    const v = sub[key];
    if (!v) return;
    if (isDiscriminated(v)) {
      for (const variant of v.variants) {
        for (const slot of variant.fields) {
          try {
            widthOf(slot.type, types);
          } catch (e) {
            errs.push(`${key} variant "${variant.kind}" slot "${slot.name}": ${(e as Error).message}`);
          }
        }
      }
    } else if (isSingleShape(v)) {
      for (const slot of v.fields) {
        try {
          widthOf(slot.type, types);
        } catch (e) {
          errs.push(`${key} slot "${slot.name}": ${(e as Error).message}`);
        }
      }
    }
  };
  checkVariants("events");
  checkVariants("actions");
  if (sub.owner && sub.owner.address !== sub.meta.address) {
    errs.push(`owner.address ${sub.owner.address} != meta.address ${sub.meta.address}`);
  }
  return errs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  const ka = Object.keys(oa).sort();
  const kb = Object.keys(ob).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(oa[k], ob[k]));
}

function decodeFixture(sub: Submission, f: Fixture): unknown {
  const types = sub.types ?? {};
  switch (f.target) {
    case "state":
      return decodeState(sub, f.raw);
    case "event":
      return decodeEventOrAction(sub.events ?? null, f.raw, types);
    case "action":
      return decodeEventOrAction(sub.actions ?? null, f.raw, types);
  }
}

async function loadJson<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path}: not found`);
  return (await file.json()) as T;
}

async function verify(contractDir: string): Promise<{ ok: boolean; grade?: Grade; errors: string[] }> {
  const errors: string[] = [];
  const contractPath = resolve(contractDir, "contract.json");
  const fixturesPath = resolve(contractDir, "fixtures.json");

  const raw = await loadJson<unknown>(contractPath);
  const result = validateSubmission(raw);
  if (!result.ok) return { ok: false, errors: result.errors };
  const submission = result.submission;

  errors.push(...semanticChecks(submission));
  if (errors.length) return { ok: false, errors };

  const fixturesFile = await Bun.file(fixturesPath).exists() ? await loadJson<FixtureFile>(fixturesPath) : { fixtures: [] };
  for (let i = 0; i < fixturesFile.fixtures.length; i++) {
    const f = fixturesFile.fixtures[i]!;
    let actual: unknown;
    try {
      actual = decodeFixture(submission, f);
    } catch (e) {
      errors.push(`fixture[${i}] (${f.target}): decoder error: ${(e as Error).message}`);
      continue;
    }
    if (!deepEqual(actual, f.expected)) {
      errors.push(`fixture[${i}] (${f.target}): expected ${JSON.stringify(f.expected)} actual ${JSON.stringify(actual)}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  let grade: Grade = "community-submitted";
  if (submission.owner) {
    if (!verifySubmission(submission)) {
      errors.push("owner: signature does not verify against meta.address");
      return { ok: false, errors };
    }
    grade = "owner-signed";
  } else if (submission.meta.source && submission.meta.vkeyHash) {
    grade = "source-linked";
  }

  return { ok: true, grade, errors: [] };
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: verify <contract-dir>");
  process.exit(2);
}

const result = await verify(arg);
if (!result.ok) {
  for (const e of result.errors) console.error(`FAIL: ${e}`);
  console.error(`FAIL — ${result.errors.length} error(s)`);
  process.exit(1);
}
console.log("schema:    OK");
console.log("semantic:  OK");
console.log("fixtures:  OK");
console.log(`PASS — grade: ${result.grade}`);
