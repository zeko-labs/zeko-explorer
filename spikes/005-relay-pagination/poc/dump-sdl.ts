import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { printSchema } from "graphql"
import { schemaA } from "./src/approach-a-full-relay.js"
import { schemaB } from "./src/approach-b-custom.js"

const here = dirname(fileURLToPath(import.meta.url))

writeFileSync(join(here, "schema-a-full-relay.graphql"), printSchema(schemaA) + "\n")
writeFileSync(join(here, "schema-b-custom.graphql"), printSchema(schemaB) + "\n")

console.log("Wrote schema-a-full-relay.graphql")
console.log("Wrote schema-b-custom.graphql")
