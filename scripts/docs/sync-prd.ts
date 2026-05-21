import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The root package entrypoint currently re-exports an extensionless helper path.
import { convertFile } from "@kreuzberg/html-to-markdown/dist/helpers.js";

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docsDir = join(rootDir, "docs");
const htmlPath = join(docsDir, "PRD.html");
const markdownPath = join(docsDir, "PRD.md");
const checkOnly = process.argv.includes("--check");

if (!existsSync(htmlPath)) {
  console.log("docs/PRD.html not found; leaving docs/PRD.md unchanged.");
  process.exit(0);
}

const result = await convertFile(htmlPath, { skipImages: true });
const markdown = `${(result.content ?? "").trimEnd()}\n`;

if (checkOnly) {
  const current = existsSync(markdownPath) ? await readFile(markdownPath, "utf8") : "";

  if (current !== markdown) {
    console.error("docs/PRD.md is out of sync with docs/PRD.html. Run `moon run root:sync-prd`.");
    process.exit(1);
  }

  console.log("docs/PRD.md is in sync with docs/PRD.html.");
  process.exit(0);
}

await writeFile(markdownPath, markdown);
console.log("Updated docs/PRD.md from docs/PRD.html.");
