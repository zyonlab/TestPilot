/**
 * Claude 臂的用例节点：逐个领用例单元，把 `claude-cases.json` 里对应故事的用例写进去。
 * 走的是和机器臂**同一条**单元循环（claim_unit → write_unit → 服务端合并）。
 * 只带路，不产内容：内容由 Claude 臂自己写在那个文件里。
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!, runId = arg("run")!, dir = resolve(arg("dir")!);
const { RunGateway } = await import("testpilot-mcp/run-gateway");
const gateway = new RunGateway();
const byStory = new Map<string, unknown[]>();
for (const c of JSON.parse(readFileSync(join(dir, "claude-cases.json"), "utf8")).cases as Array<{ storyId: string }>)
  byStory.set(c.storyId, [...(byStory.get(c.storyId) ?? []), c]);

await gateway.call(runId, "begin-stage", { node: "cases" });
if (process.argv.includes("--peek")) {
  const c = await gateway.call(runId, "stages/units/claim", { node: "cases" }) as Record<string, any>;
  console.log(JSON.stringify({ unit: c.unit?.unitId, scope: c.unit?.scope, story: c.materials?.story,
    features: c.materials?.features, rules: c.materials?.rules, contract: c.contract }, null, 1).slice(0, 6000));
  process.exit(0);
}
for (let i = 0; i < 200; i++) {
  const c = await gateway.call(runId, "stages/units/claim", { node: "cases" }) as Record<string, any>;
  if (!c.unit) { console.log("单元领完了：", String(c.instruction).slice(0, 120)); break; }
  const storyId = c.unit.scope.storyId as string;
  const cases = byStory.get(storyId);
  if (!cases) { console.log(`⚠ ${storyId} 没有写用例，跳过会卡住循环`); break; }
  const out = await gateway.call(runId, "stages/units/write", { unitId: c.unit.unitId, content: { cases } }) as Record<string, any>;
  console.log(`${c.unit.unitId}: ${out.status} · ${cases.length} 条` +
    (out.status !== "validated" ? ` → ${JSON.stringify(out.errors ?? out).slice(0, 500)}` : ""));
  if (out.status !== "validated") break;
  if (out.merged) console.log("合并:", JSON.stringify(out.merged).slice(0, 300));
}
