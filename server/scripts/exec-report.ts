/** 汇总一次执行的逐条结果（只读）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const [projectId, executionId] = process.argv.slice(2);
const l = runLedger();
const row = l.db.prepare("SELECT id,runId,status,codeRevision,resultRevision,startedAt FROM workflow_executions WHERE id=?").get(executionId) as Record<string, string> | undefined;
if (!row) throw new Error("execution_missing");
console.log(JSON.stringify({ id: row.id, runId: row.runId, status: row.status, startedAt: row.startedAt }));
if (!row.resultRevision) { console.log("no result revision yet"); process.exit(0); }
const content = l.readRevision(row.resultRevision, projectId!).content as { results?: Array<Record<string, unknown>>; status?: string };
const results = content.results ?? [];
const by: Record<string, number> = {};
for (const r of results) by[String(r.status)] = (by[String(r.status)] ?? 0) + 1;
console.log("summary", JSON.stringify(by));
for (const r of results)
  console.log(` ${String(r.caseId).padEnd(14)} ${String(r.status).padEnd(9)} ${String((r as { reason?: string; error?: string }).reason ?? (r as { error?: string }).error ?? "").slice(0, 110).replace(/\n/g, " ")}`);
