/** 只读：把「真的绿」和「免费的绿」分开。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const row = l.db.prepare("SELECT projectId, resultRevision FROM workflow_executions WHERE id=?").get(process.argv[2]!) as any;
const c = l.readRevision(row.resultRevision, row.projectId).content as any;
let free = 0, earned = 0, failed = 0;
console.log("用例      状态    判据（heldBefore=步骤跑之前就成立）");
for (const r of c.results) {
  const os = (r.oracle ?? []) as any[];
  const anyFree = os.some((o) => o.heldBefore === true && o.status === "pass");
  const allFree = os.length > 0 && os.every((o) => o.heldBefore === true);
  if (r.status === "passed") { if (allFree) free++; else earned++; }
  else failed++;
  const mark = r.status !== "passed" ? "  " : allFree ? "⚠⚠" : anyFree ? "⚠ " : "✓ ";
  console.log(`${mark}${r.caseId}  ${String(r.status).padEnd(6)} ${os.map((o) => `${o.decidedBy}:${o.status}${o.heldBefore === true ? "(免费)" : o.heldBefore === false ? "(挣来的)" : ""}`).join(" ")}`);
}
console.log(`\n通过里：挣来的 ${earned} 条 · 每条判据在初始页面就成立（免费的绿）${free} 条 · 失败 ${failed} 条`);
