import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [execId, caseId] = process.argv.slice(2);
const row = l.db.prepare("SELECT projectId, resultRevision FROM workflow_executions WHERE id=?").get(execId!) as { projectId: string; resultRevision: string };
const c = l.readRevision(row.resultRevision, row.projectId).content as { results: Array<Record<string, any>> };
const r = c.results.find(x => x.caseId === caseId)!;
console.log("status", r.status, "durationMs", r.durationMs, "phases", JSON.stringify(r.phases));
console.log("modelRequests:", Array.isArray(r.modelRequests) ? r.modelRequests.length : r.modelRequests,
  "forwarded:", Array.isArray(r.modelRequests) ? r.modelRequests.filter((m:any)=>m.forwarded).length : "-");
if (Array.isArray(r.modelRequests)) console.log(JSON.stringify(r.modelRequests.map((m:any)=>({role:m.role,model:m.model,forwarded:m.forwarded,error:m.error,ms:m.durationMs})), null, 0).slice(0,1500));
console.log("oracle:", JSON.stringify(r.oracle));
console.log("logs:"); for (const x of (r.logs ?? [])) console.log("  " + String(x).slice(0, 220));
