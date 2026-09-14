/** 只读：看最近的 workflow execution 及其结果修订。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const execId = process.argv[2];
if (!execId) {
  console.log(JSON.stringify(l.db.prepare("SELECT id, projectId, status, resultRevision, codeRevision FROM workflow_executions ORDER BY rowid DESC LIMIT 6").all(), null, 1));
} else {
  const row = l.db.prepare("SELECT * FROM workflow_executions WHERE id=?").get(execId) as Record<string, unknown>;
  console.log("row:", JSON.stringify({ ...row, detail: undefined, environmentEnc: undefined }, null, 1));
  if (row.detail) console.log("detail:", String(row.detail).slice(0, 3000));
  if (row.resultRevision) {
    const c = l.readRevision(String(row.resultRevision), String(row.projectId)).content as Record<string, unknown>;
    console.log("result keys:", Object.keys(c).join(", "));
    console.log("result(no results):", JSON.stringify({ ...c, results: undefined, cases: undefined }, null, 1).slice(0, 3000));
    const rs = (c.results ?? c.cases) as Array<Record<string, unknown>> | undefined;
    if (rs) {
      console.log("N results:", rs.length);
      console.log("first:", JSON.stringify(rs[0], null, 1).slice(0, 2500));
    }
  }
}
