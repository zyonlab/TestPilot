/** 只读：按模块看这批用例的成色（步骤形状、负例、判据、就绪度）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const [runId, projectId, codeRevision] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
const revs = l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/stories");
const st = l.readRevision(revs.at(-1)!.id, projectId!).content as any;
const modOf = new Map<string, string>();
for (const s of (st.stories ?? st)) modOf.set(s.id, (s.moduleIds ?? [])[0] ?? "(无)");
const CHECK = /^\s*(确认|验证|检查|断言|校验|观察|assert|verify|ensure|check|confirm)/i;
const STATE = /显示|可见|不可见|存在|不存在|出现|未出现|处于|激活|为空|非空|勾选|选中|保持|仍是|应该|是默认|为|\bis\b|shows?|displays?|visible/i;
const rows = new Map<string, any>();
for (const k of b.cases) {
  const m = modOf.get(k.storyId) ?? "?";
  const r = rows.get(m) ?? { n: 0, badStep: 0, neg: 0, oracles: 0, ready: 0, steps: 0, p0: 0 };
  r.n++; r.steps += (k.steps ?? []).length;
  if ((k.steps ?? []).some((s: string) => CHECK.test(s.trim()) && STATE.test(s))) r.badStep++;
  if (k.scenarioType === "negative" || k.designMethod === "boundary" || k.designMethod === "negative") r.neg++;
  if (k.oracle || (k.assertions ?? []).some((a: any) => a.oracle)) r.oracles++;
  if (k.readiness?.execution === "ready") r.ready++;
  if (k.priority === "P0") r.p0++;
  rows.set(m, r);
}
console.log("模块                       条数 步均 断言当步骤 负例 有判据 可执行 P0");
for (const [m, r] of [...rows].sort((a, z) => z[1].n - a[1].n))
  console.log(`${m.padEnd(26)} ${String(r.n).padStart(3)} ${(r.steps / r.n).toFixed(1).padStart(4)} ${String(r.badStep).padStart(9)} ${String(r.neg).padStart(4)} ${String(r.oracles).padStart(6)} ${String(r.ready).padStart(6)} ${String(r.p0).padStart(3)}`);
