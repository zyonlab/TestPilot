/** 用当前门禁规则对已冻结的产物重算一次分（只读，不写任何 revision）。 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const { runGate } = await import("@testpilot/harness-testing/casegen");
for (const arm of process.argv.slice(2)) {
  const b = JSON.parse(readFileSync(resolve(arm), "utf8"));
  const r = runGate(b, { minNegativeRatio: 0.3 });
  const by: Record<string, number> = {};
  for (const f of r.findings) by[f.rule] = (by[f.rule] ?? 0) + 1;
  const warns = r.findings.filter((f) => f.severity === "warn");
  console.log(JSON.stringify({ arm, score: r.score, findings: r.findings.length, warns: warns.length,
    flaggedCases: (r as { scoreBasis?: { flagged?: string[] } }).scoreBasis?.flagged?.length ?? 0, byRule: by }, null, 0));
}
