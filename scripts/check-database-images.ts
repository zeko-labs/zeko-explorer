import { readFile } from "node:fs/promises";

type DatabaseImages = {
  readonly surrealdb: string;
  readonly surrealkit: string;
};

const images = await readDatabaseImages();
const ciWorkflow = await readFile(".github/workflows/ci.yaml", "utf8");

expectContains(ciWorkflow, `image: ${images.surrealdb}`, ".github/workflows/ci.yaml");

console.log(".github/workflows/ci.yaml uses the SurrealDB image from services/database/database-images.json.");

async function readDatabaseImages(): Promise<DatabaseImages> {
  const raw = await readFile("services/database/database-images.json", "utf8");
  const parsed = JSON.parse(raw) as Partial<Record<keyof DatabaseImages, unknown>>;
  if (typeof parsed.surrealdb !== "string") {
    throw new Error("services/database/database-images.json must define surrealdb.");
  }
  if (typeof parsed.surrealkit !== "string") {
    throw new Error("services/database/database-images.json must define surrealkit.");
  }
  return { surrealdb: parsed.surrealdb, surrealkit: parsed.surrealkit };
}

function expectContains(content: string, expected: string, file: string): void {
  if (!content.includes(expected)) {
    console.error(`${file} does not reference expected image string: ${expected}`);
    process.exit(1);
  }
}
