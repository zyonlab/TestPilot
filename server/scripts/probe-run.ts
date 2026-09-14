/** 打印一个 run 的事件与产物（调试用）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const [runId, projectId] = process.argv.slice(2);
const l = runLedger();
for (const e of l.db.prepare("SELECT json FROM workflow_events WHERE runId=? ORDER BY rowid").all(runId) as Array<{ json: string }>) {
  const v = JSON.parse(e.json) as Record<string, unknown>;
  console.log(v.node, v.attempt, v.sequence, v.phase, String(v.message ?? "").slice(0, 400));
}
console.log("--- revisions:");
for (const r of l.listRevisions(projectId!, runId!)) console.log(" ", r.name, r.kind, r.revision);
const row = l.getRun(runId!, projectId!);
console.log("--- status:", row.status);
