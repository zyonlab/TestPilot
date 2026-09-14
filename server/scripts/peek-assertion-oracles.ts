import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const [runId, projectId, codeRevision] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
let allCovered = 0, partial = 0, noAssertions = 0, noOracleAtAll = 0, kinds = new Map<string, number>();
for (const k of b.cases) {
  const a = k.assertions ?? [];
  const withO = a.filter((x: any) => x.oracle);
  for (const x of withO) kinds.set(x.oracle.kind, (kinds.get(x.oracle.kind) ?? 0) + 1);
  if (!a.length) { noAssertions++; if (!k.oracle) noOracleAtAll++; continue; }
  if (withO.length === a.length) allCovered++;
  else if (withO.length) partial++;
  else noOracleAtAll++;
}
console.log(`81 条：每条断言都有判据 ${allCovered} · 部分断言有 ${partial} · 没有 assertions[] ${noAssertions} · 一个判据都没有 ${noOracleAtAll}`);
console.log("断言级判据种类:", JSON.stringify([...kinds].sort((a, z) => z[1] - a[1])));
const tiers = new Map<number, number>();
for (const k of b.cases) if (k.tier <= 2) tiers.set(k.tier, (tiers.get(k.tier) ?? 0) + 1);
console.log("tier1/2 用例数:", JSON.stringify([...tiers]));
