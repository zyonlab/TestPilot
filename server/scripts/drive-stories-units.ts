/**
 * 用**工作单元循环**跑 stories 节点：一个根模块一次调用，而不是整份一次写完。
 *
 * 这是 docs/v3/24 §12 那个问题的对照实验：机器臂 26 条故事、Claude 臂 32 条，差的到底是
 * 「话术没说清」还是「一次答复里写不下」。前三轮改话术只把可见输出稳定在 ~7k token，
 * 推理却从 15.6k 涨到 21.8k——**加话术买到的是思考，不是覆盖**。那就把预算拆开试。
 *
 * 除了拆分，其余一切不变：同一个模型、同两份材料、同一份 STORY_CONTRACT。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!;
const out = resolve(arg("out") ?? join(root, "docs/v3/evidence/module-stories-2026-09-12/units"));
mkdirSync(out, { recursive: true });
const maxTokens = Number(arg("maxTokens") ?? 40000);

const { RunGateway } = await import("testpilot-mcp/run-gateway");
const { projectModelConnection } = await import("../src/modelProfiles.js");
const conn = projectModelConnection(projectId, "planner");
async function ask(user: string) {
  const { request } = await import("node:https");
  const u = new URL(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`);
  const body = JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens,
    messages: [{ role: "system", content: "只回 JSON。" }, { role: "user", content: user }] });
  const t0 = Date.now();
  const text: string = await new Promise((ok, fail) => {
    const req = request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}`, "content-length": Buffer.byteLength(body) } },
      (res) => { const cs: Buffer[] = []; res.on("data", (c: Buffer) => cs.push(c)); res.on("end", () => ok(Buffer.concat(cs).toString("utf8"))); });
    req.setTimeout(30 * 60_000, () => req.destroy(new Error("REQUEST_TIMEOUT")));
    req.on("error", fail); req.end(body);
  });
  const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, any> };
  const raw = json.choices?.[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  return { parsed: m ? JSON.parse(m[0]) as { stories?: unknown[] } : {}, usage: json.usage, ms: Date.now() - t0 };
}

const skill = readFileSync(join(root, "plugins/testpilot/skills/testpilot-run-c/SKILL.md"), "utf8");
const step = (n: number) => skill.split("\n").find((l) => l.startsWith(`${n}. `))!;
const materials = ["domain-perp-zh.md", "observed-zh.md"].map((name) =>
  ({ name, text: readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials", name), "utf8") }));
const corpus = ["<domain_knowledge>", materials[0]!.text, "</domain_knowledge>", "", "<observed_ui>", materials[1]!.text, "</observed_ui>"].join("\n");
const sectionNote = materials.map((m) => `${m.name}: ${m.text.split("\n").filter((l) => /^##\s+\S/.test(l)).length} 段`).join("；");

const gateway = new RunGateway();
const key = `arm-units-${Date.now()}`;
const { runId } = await gateway.register(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
  materials, parameters: { stageControlVersion: 1, workUnits: 1 } }) as { runId: string };
const log: Record<string, unknown> = { runId, arm: "machine-units" };

// modules：和前几轮同一段话术，同一条路由。
await gateway.call(runId, "begin-stage", { node: "modules" });
const { toolDesc } = { toolDesc: readFileSync(join(root, "packages/testpilot-mcp/src/server.ts"), "utf8")
  .split('server.registerTool("plan_modules"')[1]!.split("inputSchema")[0]!
  .match(/description:\s*"((?:[^"\\]|\\.)*)"/)![1]!.replace(/\\"/g, '"') };
const mo = await ask(["你是这次运行的规划器。当前节点：modules。", "", "工作流要求：", step(4), "",
  "plan_modules 契约：", toolDesc, "", `材料分段：${sectionNote}，段 id 写成 <文件名>#<序号>。`,
  '只回 JSON：{"modules":[...],"outOfScope":[...]}；modules 每项 {id,name,parentId|null,purpose,evidence:[段 id]}。', "", corpus].join("\n"));
const written = await gateway.call(runId, "stages/modules", { content: mo.parsed }) as Record<string, any>;
console.log("modules:", written.status, ((mo.parsed as any).modules ?? []).length, "· 推理", mo.usage?.reasoning_tokens);
if (written.status !== "validated") { writeFileSync(join(out, "units-arm.json"), JSON.stringify({ ...log, modules: written }, null, 2)); process.exit(1); }
await (await fetch(`http://127.0.0.1:5301/api/projects/${projectId}/workflow-runs/${runId}/modules/freeze`,
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();

await gateway.call(runId, "begin-stage", { node: "instructions" });
await gateway.call(runId, "stages/instructions", {});
await gateway.call(runId, "stages/retrieve", { query: "永续合约交易页的模块与用户任务", budgetTokens: 4000 });
const begun = await gateway.call(runId, "begin-stage", { node: "stories" }) as { structureContract?: string };

// 单元循环：服务端拆、规划器一次只领一个。
const rounds: unknown[] = [];
for (let i = 0; i < 24; i++) {
  const claimed = await gateway.call(runId, "stages/units/claim", { node: "stories" }) as
    { unit?: { unitId: string; scope: any }; instruction?: string; materials?: any; merged?: any };
  if (!claimed.unit) { log.merged = claimed.merged ?? claimed.instruction; break; }
  const scope = claimed.unit.scope;
  const ids: string[] = scope.kind === "module" ? scope.moduleIds : scope.moduleIds ?? [];
  const named = (claimed.materials?.modules ?? []).map((m: any) => `  ${m.id} — ${m.name}`).join("\n");
  const res = await ask(["你是这次运行的规划器。当前节点：stories。**这一轮只写一个单元**：",
    claimed.unit.unitId, "", "工作流要求：", step(5), "", "结构契约：", begun.structureContract ?? "", "",
    `这个单元的模块（moduleIds 只能取这些，逐字照抄）：`, JSON.stringify(ids), named ? "模块名称：\n" + named : "",
    scope.kind === "journeys" ? "这个单元只写跨模块旅程：每条故事引用 ≥2 个模块，且不要重复各模块单元里已有的故事 id。" : "只写这些模块的故事，别的模块留给别的单元。",
    "", `材料分段：${sectionNote}。`,
    '只回 JSON：{"stories":[...]}；每项 {id,title,role,benefit,moduleIds,acceptance,source}。', "", corpus].join("\n"));
  const w = await gateway.call(runId, "stages/units/write", { unitId: claimed.unit.unitId, content: { stories: res.parsed.stories ?? [] } }) as Record<string, any>;
  rounds.push({ unitId: claimed.unit.unitId, status: w.status, stories: (res.parsed.stories ?? []).length, usage: res.usage, ms: res.ms,
    errors: w.errors?.slice?.(0, 4) });
  console.log(`  ${claimed.unit.unitId}: ${w.status} · ${(res.parsed.stories ?? []).length} 条 · 推理 ${res.usage?.reasoning_tokens} · 可见 ${(res.usage?.completion_tokens ?? 0) - (res.usage?.reasoning_tokens ?? 0)}`);
  if (w.merged) log.merged = w.merged;
}
log.rounds = rounds;
writeFileSync(join(out, "units-arm.json"), JSON.stringify(log, null, 2));
console.log("runId", runId, "· 单元轮数", rounds.length);
