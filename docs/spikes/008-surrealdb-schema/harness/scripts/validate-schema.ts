import { startSurreal, stopSurreal, runSql, syncSchema } from "../lib/surreal-client.ts";

type DbInfo = { tables: Record<string, string> };

await startSurreal();
try {
  const db = `validate_${Date.now()}`;
  await syncSchema(db);
  const info = await runSql<DbInfo>(db, "INFO FOR DB;");
  const result = info[0]?.result;
  if (result === undefined) throw new Error("INFO FOR DB returned no result");
  const tableNames = Object.keys(result.tables).sort();
  console.log(`Validated schema with ${tableNames.length} tables: ${tableNames.join(", ")}`);
} finally {
  await stopSurreal();
}
