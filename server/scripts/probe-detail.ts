import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const row = runLedger().getRun(process.argv[2]!, process.argv[3]!);
const d = row.detail as { penguin?: Record<string, unknown> };
console.log(JSON.stringify({ status: row.status, penguin: d.penguin }, null, 1));
