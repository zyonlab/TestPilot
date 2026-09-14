/**
 * 把 Claude 臂的产物送进和机器臂**同一批节点**：注册 run → modules → 人冻结 → instructions → stories。
 *
 * 参数化到底：材料、产物目录都从命令行来，脚本里不写死任何地址与 fixture 路径。
 * 地址取项目的 targetUrl——被测对象是项目的属性，不是脚本的。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const many = (k: string) => process.argv.flatMap((a, i) => (a === `--${k}` ? [process.argv[i + 1]!] : []));
const projectId = arg("project")!, dir = resolve(arg("dir")!), label = arg("label") ?? "claude";
const { RunGateway } = await import("testpilot-mcp/run-gateway");
const gateway = new RunGateway();
const materials = many("material").map((p) => ({ name: basename(p), text: readFileSync(resolve(p), "utf8") }));
if (!materials.length) throw new Error("给至少一份材料：--material <file>");

const key = `${label}-${Date.now()}`;
const { runId } = await gateway.register(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
  materials, parameters: { stageControlVersion: 1 } }) as { runId: string };

const plan = JSON.parse(readFileSync(join(dir, "claude-modules.json"), "utf8"));
await gateway.call(runId, "begin-stage", { node: "modules" });
const modules = await gateway.call(runId, "stages/modules", { content: plan }) as Record<string, any>;
console.log("modules:", modules.status, (plan.modules ?? []).length, "模块 · findings", (modules.findings ?? []).length);
if (modules.status !== "validated") { console.log(JSON.stringify(modules.errors ?? modules, null, 1).slice(0, 900)); process.exit(1); }
const freeze = await (await fetch(`http://127.0.0.1:5301/api/projects/${projectId}/workflow-runs/${runId}/modules/freeze`,
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
console.log("freeze:", JSON.stringify(freeze));

await gateway.call(runId, "begin-stage", { node: "instructions" });
await gateway.call(runId, "stages/instructions", {});
await gateway.call(runId, "stages/retrieve", { query: "产品的模块与用户任务", budgetTokens: 4000 });
await gateway.call(runId, "begin-stage", { node: "stories" });
const stories = JSON.parse(readFileSync(join(dir, "claude-stories.json"), "utf8")).stories;
const payload = { origin: "host", flows: [], derivedFrom: "exploration",
  modules: plan.modules.map((m: any) => ({ id: m.id, name: m.name ?? m.id, ...(m.parentId ? { parentId: m.parentId } : {}),
    kind: m.parentId ? "submodule" : "module", flowIds: [], routes: [] })), stories };
const out = await gateway.call(runId, "stages/stories", { content: payload }) as Record<string, any>;
console.log("stories:", out.status, stories.length, "条 ·",
  JSON.stringify((out.modulePlan ?? []).map((f: { code: string }) => f.code)));
if (out.status !== "validated") console.log(JSON.stringify(out.errors ?? out, null, 1).slice(0, 900));
writeFileSync(join(dir, `node-${label}.json`), JSON.stringify({ runId, modules, freeze, stories: out }, null, 2));
console.log("runId", runId);
