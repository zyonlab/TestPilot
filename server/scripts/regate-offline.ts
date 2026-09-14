/** 只读：拿这次运行的真产物离线重打分，看新规则点到了什么。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { runGate } = await import("@testpilot/harness-testing/casegen");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
const rev = l.listRevisions(projectId!, runId!).filter((r: any) => r.name === "validated/cases").sort((a: any, z: any) => a.revision - z.revision).at(-1)!;
const bundle = l.readRevision(rev.id, projectId!).content as any;
const r = runGate(bundle, { minNegativeRatio: 0.3 });
const by = new Map<string, number>();
for (const f of r.findings) by.set(`${f.rule}/${f.severity}`, (by.get(`${f.rule}/${f.severity}`) ?? 0) + 1);
console.log(`用例 ${bundle.cases.length} 条 · 故事 ${bundle.stories.length} 条 · score ${r.score?.toFixed(3)} · findings ${r.findings.length}`);
for (const [k, n] of [...by].sort((a, z) => z[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log("\n--- 新规则各举三条 ---");
for (const rule of ["acceptance-uncovered", "case-without-action", "step-not-an-action"])
  for (const f of r.findings.filter((x: any) => x.rule === rule).slice(0, 3))
    console.log(`  [${rule}] ${f.caseId ?? ""} ${f.message.slice(0, 118)}`);
const flagged = new Set(r.findings.filter((f: any) => f.rule === "step-not-an-action").map((f: any) => f.caseId));
console.log(`\nstep-not-an-action 点到 ${flagged.size} 条用例 / ${bundle.cases.length}`);
const steps = new Map<string, number>();
for (const f of r.findings.filter((x: any) => x.rule === "step-not-an-action")) {
  const m = /: "(.+)"$/.exec(f.message); const t = m ? m[1] : f.message;
  steps.set(t, (steps.get(t) ?? 0) + 1);
}
console.log("被点名的步骤原文（去重，按出现次数）：");
for (const [t, n] of [...steps].sort((a, z) => z[1] - a[1])) console.log(`  ${String(n).padStart(2)}× ${t}`);
