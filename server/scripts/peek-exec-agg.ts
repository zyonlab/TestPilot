/** 只读：把一次 execution 的 81 条结果按状态/归因聚合。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const execId = process.argv[2]!;
const row = l.db.prepare("SELECT projectId, resultRevision FROM workflow_executions WHERE id=?").get(execId) as { projectId: string; resultRevision: string };
const c = l.readRevision(row.resultRevision, row.projectId).content as { results: Array<Record<string, any>> };
const rs = c.results;
const by = (f: (r: any) => string) => { const m = new Map<string, number>(); for (const r of rs) m.set(f(r), (m.get(f(r)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
console.log("keys of a result:", Object.keys(rs[0]!).join(", "));
console.log("status:", JSON.stringify(by(r => String(r.status ?? r.verdict ?? r.passed))));
console.log("failure.code:", JSON.stringify(by(r => String(r.failure?.code ?? "-"))));
console.log("attribution:", JSON.stringify(by(r => String(r.failure?.attribution ?? "-"))));
console.log("entryUrl:", JSON.stringify(by(r => String(r.entryUrl ?? "-"))));
const dur = rs.map(r => Number(r.durationMs ?? 0)).sort((a, b) => a - b);
console.log("durationMs p0/p50/p100:", dur[0], dur[Math.floor(dur.length / 2)], dur[dur.length - 1], "zero:", dur.filter(d => d === 0).length);
console.log("\n-- 前 40 条失败信息首句 --");
for (const r of rs) {
  const m = String(r.failureReason ?? "").split("\n")[0]!.slice(0, 150);
  console.log(`${r.caseId}\t${r.status ?? r.verdict ?? r.passed}\t${r.failure?.attribution ?? "-"}\t${m}`);
}
