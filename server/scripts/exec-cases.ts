import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const [projectId, executionId] = process.argv.slice(2);
const l = runLedger();
const row = l.db.prepare("SELECT resultRevision FROM workflow_executions WHERE id=?").get(executionId) as { resultRevision: string };
const c = l.readRevision(row.resultRevision, projectId!).content as { results: Array<Record<string, unknown>> };
for (const r of c.results)
  console.log(JSON.stringify({ caseId: r.caseId, status: r.status, infraError: r.infraError, ms: r.durationMs,
    code: (r.failure as { code?: string } | undefined)?.code, attribution: (r.failure as { attribution?: string } | undefined)?.attribution,
    reason: String(r.failureReason ?? "").split("\n")[0].slice(0, 150) }, null, 0));
