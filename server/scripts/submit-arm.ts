/**
 * 把一条**人写的**臂送进同一批节点。
 *
 * 和 `drive-modules-and-stories.ts` 唯一的差别是产物从哪来：那边是模型在循环里现写的，
 * 这边是磁盘上的两个 JSON。路由、校验、冻结、顺序完全一样——不一样的话两臂就没得比。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!, label = arg("label") ?? "arm";
const dir = resolve(arg("dir")!);
const { RunGateway } = await import("testpilot-mcp/run-gateway");
const gateway = new RunGateway();
const materials = ["domain-perp-zh.md", "observed-zh.md"].map((name) =>
  ({ name, text: readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials", name), "utf8") }));
const key = `${label}-${Date.now()}`;
const { runId } = await gateway.register(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
  materials, parameters: { stageControlVersion: 1 } }) as { runId: string };

const plan = JSON.parse(readFileSync(join(dir, "claude-modules.json"), "utf8"));
await gateway.call(runId, "begin-stage", { node: "modules" });
const modules = await gateway.call(runId, "stages/modules", { content: plan }) as Record<string, any>;
console.log("modules:", modules.status, (plan.modules ?? []).length, "模块 · findings", (modules.findings ?? []).length);
if (modules.status !== "validated") { console.log(JSON.stringify(modules.errors ?? modules, null, 1)); process.exit(1); }
const freeze = await (await fetch(`http://127.0.0.1:5301/api/projects/${projectId}/workflow-runs/${runId}/modules/freeze`,
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
console.log("freeze:", JSON.stringify(freeze));

await gateway.call(runId, "begin-stage", { node: "instructions" });
await gateway.call(runId, "stages/instructions", {});
await gateway.call(runId, "stages/retrieve", { query: "永续合约交易页的模块与用户任务", budgetTokens: 4000 });
await gateway.call(runId, "begin-stage", { node: "stories" });
const stories = JSON.parse(readFileSync(join(dir, "claude-stories.json"), "utf8")).stories;
const payload = { origin: "host", flows: [], derivedFrom: "exploration",
  modules: plan.modules.map((m: any) => ({ id: m.id, name: m.name ?? m.id, ...(m.parentId ? { parentId: m.parentId } : {}),
    kind: m.parentId ? "submodule" : "module", flowIds: [], routes: [] })), stories };
const out = await gateway.call(runId, "stages/stories", { content: payload }) as Record<string, any>;
console.log("stories:", out.status, stories.length, "条");
if (out.status !== "validated") console.log(JSON.stringify(out.errors ?? out, null, 1).slice(0, 1200));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `node-${label}.json`), JSON.stringify({ runId, modules, freeze, stories: out }, null, 2));
console.log("runId", runId);
