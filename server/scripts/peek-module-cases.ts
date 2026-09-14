/** 只读：一个模块下的用例逐条看。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const l = runLedger();
const [runId, projectId, codeRevision, mod] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
const st = l.readRevision(l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId!).content as any;
const modOf = new Map<string, string>();
for (const s of (st.stories ?? st)) modOf.set(s.id, (s.moduleIds ?? [])[0] ?? "(无)");
const CHECK = /^\s*(确认|验证|检查|断言|校验|观察|assert|verify|ensure|check|confirm)/i;
const STATE = /显示|可见|不可见|存在|不存在|出现|未出现|处于|激活|为空|非空|勾选|选中|保持|仍是|应该|是默认|为|\bis\b|shows?|displays?|visible/i;
const ids: string[] = [];
for (const k of b.cases) {
  if (modOf.get(k.storyId) !== mod) continue;
  ids.push(k.id);
  const bad = (k.steps ?? []).filter((s: string) => CHECK.test(s.trim()) && STATE.test(s));
  const o = k.oracle ?? (k.assertions ?? []).map((a: any) => a.oracle).find(Boolean);
  console.log(`${k.id} [${k.scenarioType ?? "-"}/${k.designMethod}] ${k.priority} ${k.readiness?.execution ?? "-"} tier${k.tier} oracle=${o ? o.kind : "无"}${bad.length ? `  ⚠断言当步骤×${bad.length}` : ""}`);
  console.log(`   ${k.title}`);
  for (const [i, s] of (k.steps ?? []).entries()) console.log(`   ${i + 1}. ${bad.includes(s) ? "⚠ " : ""}${s.slice(0, 100)}`);
  if (k.postSteps?.length) console.log(`   ↩ ${k.postSteps.join(" / ").slice(0, 100)}`);
}
console.log("\ncaseIds:", JSON.stringify(ids));
