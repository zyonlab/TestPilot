/** 只读：失败/中断的运行各停在哪个节点、最后几条阶段事件说了什么。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const runs = l.db.prepare("SELECT id, status, startedAt FROM wf_runs ORDER BY rowid DESC LIMIT 40").all() as Array<{ id: string; status: string; startedAt: string }>;
for (const r of runs) {
  if (!["failed", "interrupted"].includes(r.status)) continue;
  const rows = l.db.prepare("SELECT json FROM workflow_events WHERE runId=? ORDER BY rowid DESC LIMIT 6").all(r.id) as Array<{ json: string }>;
  console.log(`\n${r.startedAt.slice(11, 19)} ${r.id.slice(4, 12)} ${r.status}`);
  for (const row of rows.reverse()) {
    const e = JSON.parse(row.json) as { node?: string; phase?: string; message?: string };
    console.log(`   ${String(e.node)}/${String(e.phase)}  ${(e.message ?? "").slice(0, 120)}`);
  }
}
