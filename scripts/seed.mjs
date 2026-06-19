// seed.mjs — load the initial gp-config ACTIVE row and the gp-watchlist rows.
//
// This is a WRITE operation against DynamoDB and only works AFTER the stack is
// deployed (the tables must exist). It is intentionally a separate, human-run
// step — NOT part of any automated flow.
//
// Safety: dry-run by default. It prints exactly what it WOULD write and exits.
// Pass --apply to actually PutItem. Re-running is safe (Put overwrites the same
// keys; gp-config stays a single ACTIVE row).
//
//   node scripts/seed.mjs            # dry run (prints, writes nothing)
//   node scripts/seed.mjs --apply    # writes config + watchlist
//
// Requires AWS credentials with write access to gp-config and gp-watchlist.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(HERE, "..", "seed");

const CONFIG_TABLE = process.env.CONFIG_TABLE || "gp-config";
const WATCHLIST_TABLE = process.env.WATCHLIST_TABLE || "gp-watchlist";

const apply = process.argv.includes("--apply");
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function loadJson(name) {
  return JSON.parse(await readFile(join(SEED_DIR, name), "utf8"));
}

async function putItem(tableName, item, label) {
  if (!apply) {
    console.log(`[dry-run] PUT ${tableName} <- ${label}`);
    return;
  }
  await doc.send(new PutCommand({ TableName: tableName, Item: item }));
  console.log(`[applied] PUT ${tableName} <- ${label}`);
}

const config = await loadJson("config.json");
const watchlist = await loadJson("watchlist.json");

console.log(apply ? "Seeding (APPLY)…" : "Seeding (DRY RUN — pass --apply to write)…");

// gp-config: the single ACTIVE tunables row. Guard against an accidental live flip.
if (config.alertMode !== "observe") {
  throw new Error("refusing to seed: gp-config alertMode must start as 'observe'");
}
await putItem(CONFIG_TABLE, config, "CONFIG#ACTIVE");

// gp-watchlist: one row per ticker.
for (const row of watchlist) {
  await putItem(WATCHLIST_TABLE, row, row.pk);
}

console.log(`Done. config: 1 row, watchlist: ${watchlist.length} rows.`);
if (!apply) console.log("Nothing was written. Re-run with --apply once the stack is deployed.");
