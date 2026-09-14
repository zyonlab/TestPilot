import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const [execId, ...ids] = process.argv.slice(2);
const row = l.db.prepare("SELECT runId, projectId, codeRevision FROM workflow_executions WHERE id=?").get(execId!) as any;
const b = approvedExecutionBundle(row.runId, row.projectId, row.codeRevision);
console.log("cases:", b.cases.length);
const stepIsAssert = (s: string) => /^(确认|验证|检查|断言|应当|应该|期望|assert|verify|confirm|check that)/i.test(s.trim());
let n = 0; const offenders: string[] = [];
for (const k of b.cases as any[]) { const bad = (k.steps ?? []).filter(stepIsAssert); if (bad.length) { n++; offenders.push(`${k.id}: ${bad.length}/${k.steps.length} — ${bad[0].slice(0,60)}`); } }
console.log(`把断言写成 step 的用例: ${n}/${b.cases.length}`);
for (const o of offenders.slice(0, 12)) console.log("  " + o);
for (const id of ids) { const k = (b.cases as any[]).find(x => x.id === id); console.log("\n" + JSON.stringify(k, null, 1).slice(0, 1800)); }
