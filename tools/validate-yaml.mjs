#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

let hasError = false;

for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, "utf8");
  const documents = parseAllDocuments(source, { prettyErrors: true });

  for (const document of documents) {
    for (const error of document.errors) {
      hasError = true;
      console.error(`${file}: ${error.message}`);
    }
  }
}

if (hasError) {
  process.exit(1);
}
