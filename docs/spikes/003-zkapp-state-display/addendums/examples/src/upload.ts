import { resolve } from "node:path";
import { loadAndValidate } from "./validate.ts";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const nsId = process.env.KV_NAMESPACE_ID;
if (!token || !accountId || !nsId) {
  console.error("missing env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID");
  process.exit(2);
}

const [mode, ...paths] = process.argv.slice(2);
if ((mode !== "put" && mode !== "delete") || paths.length === 0) {
  console.error("usage: upload put|delete <contract-dir>...");
  process.exit(2);
}

const endpoint = (key: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`;

async function putKey(key: string, body: string): Promise<void> {
  const r = await fetch(endpoint(key), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`PUT ${key} → ${r.status} ${await r.text()}`);
  console.log(`put    ${key}`);
}

async function deleteKey(key: string): Promise<void> {
  const r = await fetch(endpoint(key), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${key} → ${r.status} ${await r.text()}`);
  console.log(`delete ${key}`);
}

for (const p of paths) {
  const contractPath = resolve(p, "contract.json");
  // Validate before any KV write: same Ajv-compiled schema the verify CLI uses.
  // This is a second safety net — the publish job re-runs verify, but we never
  // want a raw JSON.parse result reaching Cloudflare.
  const submission = await loadAndValidate(contractPath);
  const body = await Bun.file(contractPath).text();

  for (const network of submission.meta.networks) {
    const key = `${network}:${submission.meta.address}`;
    if (mode === "put") await putKey(key, body);
    else await deleteKey(key);
  }
}
