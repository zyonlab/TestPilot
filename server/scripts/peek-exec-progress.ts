/** 只读：一次 execution 跑到哪了。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const execId = process.argv[2]!;
const row = l.db.prepare("SELECT runId, projectId, status, startedAt FROM workflow_executions WHERE id=?").get(execId) as any;
console.log(`status: ${row.status}  已跑 ${((Date.now() - Date.parse(row.startedAt)) / 60000).toFixed(1)} 分钟`);
const one = l.db.prepare("SELECT * FROM workflow_events LIMIT 1").get() ?? {};
console.log("列:", Object.keys(one).join(", "));
const ev = l.db.prepare(`SELECT * FROM workflow_events WHERE runId=? AND node='execution' ORDER BY rowid DESC LIMIT ${process.argv[3] ?? 14}`).all(row.runId) as any[];
for (const e of ev.reverse()) { const j = JSON.parse(e.json); console.log(`  ${String(j.at).slice(11,19)} ${j.phase} · ${j.message ?? ""}`); }
