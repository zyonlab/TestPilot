/** 只读：一次执行转发给执行模型多少次调用——量缓存省了多少。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
for (const execId of process.argv.slice(2)) {
  const row = l.db.prepare("SELECT resultRevision, projectId, status FROM workflow_executions WHERE id=?").get(execId) as any;
  if (!row?.resultRevision) { console.log(`${execId}  ${row?.status ?? "?"}  还没有结果`); continue; }
  const c = l.readRevision(row.resultRevision, row.projectId).content as any;
  let calls = 0, ms = 0, zero = 0, ran = 0;
  for (const r of c.results) {
    if (r.status === "not_run") continue;
    ran++;
    const n = Array.isArray(r.modelRequests) ? r.modelRequests.filter((m: any) => m.forwarded).length : 0;
    calls += n; ms += r.durationMs ?? 0; if (n === 0) zero++;
  }
  console.log(`${execId.slice(0, 18)}  ${String(c.status).padEnd(12)} 跑了 ${ran} 条 · 模型调用 ${String(calls).padStart(3)} · 零调用 ${zero} 条 · 总耗时 ${Math.round(ms / 1000)}s`);
}
