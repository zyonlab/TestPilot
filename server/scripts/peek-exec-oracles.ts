/** 只读：一次 execution 里每条用例的判决是谁下的。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const execId = process.argv[2]!;
const row = l.db.prepare("SELECT runId, projectId, codeRevision, resultRevision FROM workflow_executions WHERE id=?").get(execId) as any;
const c = l.readRevision(row.resultRevision, row.projectId).content as any;
const b = approvedExecutionBundle(row.runId, row.projectId, row.codeRevision) as any;
const kase = new Map(b.cases.map((k: any) => [k.id, k]));
console.log("selection:", JSON.stringify(c.selection));
console.log("用例      状态   tier 声明判据   实际判决      步数 模型调用 秒");
for (const r of c.results) {
  const k: any = kase.get(r.caseId);
  const declared = k?.oracle?.kind ?? (k?.assertions ?? []).map((a: any) => a.oracle?.kind).find(Boolean) ?? "无";
  const by = (r.oracle ?? []).map((o: any) => `${o.decidedBy}:${o.status}`).join(",") || "（没留判决）";
  console.log(`${r.caseId}  ${String(r.status).padEnd(6)} ${k?.tier}   ${String(declared).padEnd(8)} ${by.padEnd(14)} ${(k?.steps ?? []).length}   ${Array.isArray(r.modelRequests) ? r.modelRequests.length : "-"}   ${Math.round((r.durationMs ?? 0) / 1000)}`);
}
