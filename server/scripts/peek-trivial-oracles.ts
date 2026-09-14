/** 只读：判据在「什么都没操作」的初始页面上是不是就已经成立了。 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
await import("../src/runService.js");
const { approvedExecutionBundle } = await import("../src/approvedRuns.js");
const [runId, projectId, codeRevision, pagePath, ...only] = process.argv.slice(2);
const text: string = JSON.parse(readFileSync(pagePath!, "utf8"));
const b = approvedExecutionBundle(runId!, projectId!, codeRevision!) as any;
const holds = (o: any) => {
  if (!o) return null;
  if (o.kind === "text") return text.includes(o.value);
  if (o.kind === "noText") return !text.includes(o.value);
  if (o.kind === "count") { const n = text.split(o.value).length - 1; return o.op === "gte" ? n >= o.n : o.op === "lte" ? n <= o.n : n === o.n; }
  return null;
};
let trivial = 0, real = 0, unknown = 0;
for (const k of b.cases) {
  if (only.length && !only.includes(k.id)) continue;
  const os = [k.oracle, ...(k.assertions ?? []).map((a: any) => a.oracle)].filter(Boolean);
  if (!os.length) continue;
  const v = os.map(holds);
  const all = v.every((x) => x === true), some = v.some((x) => x === null);
  if (some) unknown++; else if (all) trivial++; else real++;
  if (only.length || all)
    console.log(`${all ? "⚠ 初始页面就成立" : "  需要操作      "} ${k.id} [${k.scenarioType}] ${k.title.slice(0, 34).padEnd(34)} ${os.map((o: any, i: number) => `${o.kind}:${JSON.stringify(o.value).slice(0, 22)}=${v[i]}`).join(" ")}`);
}
console.log(`\n有判据的用例里：初始页面就成立 ${trivial} 条 · 需要真的操作才成立 ${real} 条 · 判不出 ${unknown} 条`);
