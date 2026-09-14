import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const rows = runLedger().db.prepare("SELECT json FROM run_work_units WHERE runId=?").all(process.argv[2]!) as Array<{ json: string }>;
const units = rows.map((r) => JSON.parse(r.json) as Record<string, unknown>).sort((a, b) => (a.order as number) - (b.order as number));
for (const u of units) console.log(String(u.node).padEnd(8), String(u.unitId).padEnd(30), String(u.status).padEnd(9), "attempt=" + u.attempt, u.reason ?? "");
