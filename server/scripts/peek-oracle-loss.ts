import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const [runId, projectId, codeRevision] = process.argv.slice(2);
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
let top = 0, asrt = 0, none = 0;
for (const k of b.cases) {
  if (k.oracle) top++;
  else if ((k.assertions ?? []).some((a: any) => a.oracle)) asrt++;
  else none++;
}
console.log(`81 条：顶层 oracle ${top} 条 · 只有断言级 oracle ${asrt} 条 · 都没有 ${none} 条`);
for (const id of ["TC-008", "TC-009", "TC-013", "TC-016"]) {
  const k = b.cases.find((x: any) => x.id === id);
  console.log(`\n${id} tier=${k.tier} 顶层 oracle=${JSON.stringify(k.oracle ?? null)}`);
  console.log(`   expected=${JSON.stringify(k.expected)}`);
  console.log(`   assertions=${JSON.stringify((k.assertions ?? []).map((a: any) => ({ s: a.statement?.slice(0, 40), o: a.oracle })))}`);
}
