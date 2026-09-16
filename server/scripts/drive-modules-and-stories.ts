/**
 * 规划器在自己的循环里跑 `modules` + `stories` 两个节点（docs/v3/history/24 §10）。
 *
 * 话术全部来自产品：`testpilot-run-c/SKILL.md` 的两步 + MCP 工具的 description + 服务端
 * `begin_stage` 回的 `structureContract`。这里一个字都不替它们写——这一趟量的就是出厂话术。
 *
 * 冻结那一下必须是人：脚本停下来，由调用者在界面上按，或者带 `--freeze-as-operator` 显式声明
 * 「我就是那个人」。默认不按。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!;
const out = resolve(arg("out") ?? join(root, "docs/v3/evidence/module-stories-2026-09-12"));
mkdirSync(out, { recursive: true });
const maxTokens = Number(arg("maxTokens") ?? 40000);
const think = !process.argv.includes("--no-think");
const freezeAsOperator = process.argv.includes("--freeze-as-operator");

const { RunGateway } = await import("testpilot-mcp/run-gateway");
const { projectModelConnection } = await import("../src/modelProfiles.js");
const conn = projectModelConnection(projectId, "planner");

async function post(body: string): Promise<any> {
  const { request } = await import("node:https");
  const u = new URL(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`);
  const text: string = await new Promise((ok, fail) => {
    const req = request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}`, "content-length": Buffer.byteLength(body) } },
      (res) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => ok(Buffer.concat(chunks).toString("utf8"))); });
    req.setTimeout(30 * 60_000, () => req.destroy(new Error("REQUEST_TIMEOUT")));
    req.on("error", fail); req.end(body);
  });
  return JSON.parse(text);
}
async function ask(user: string) {
  const t0 = Date.now();
  const json = await post(JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens,
    ...(think ? {} : { reasoning_effort: "none" }), messages: [{ role: "system", content: "只回 JSON。" }, { role: "user", content: user }] }));
  const raw = json.choices?.[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  return { parsed: m ? JSON.parse(m[0]) : {}, usage: json.usage, ms: Date.now() - t0, raw };
}

/** 出厂话术：技能里的步骤 + 工具 description，逐字取。 */
const skill = readFileSync(join(root, "plugins/testpilot/skills/testpilot-run-c/SKILL.md"), "utf8");
const server = readFileSync(join(root, "packages/testpilot-mcp/src/server.ts"), "utf8");
const step = (n: number) => skill.split("\n").find((l) => l.startsWith(`${n}. `))!;
const toolDesc = (name: string) => server.split(`server.registerTool("${name}"`)[1]!.split("inputSchema")[0]!
  .match(/description:\s*"((?:[^"\\]|\\.)*)"/)![1]!.replace(/\\"/g, '"');

const materials = ["domain-perp-zh.md", "observed-zh.md"].map((name) =>
  ({ name, text: readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials", name), "utf8") }));
const sectionNote = materials.map((m) => `${m.name}: ${m.text.split("\n").filter((l) => /^##\s+\S/.test(l)).length} 段，段 id 写成 ${m.name}#1 … ${m.name}#N`).join("；");
const corpus = ["<domain_knowledge>", materials[0]!.text, "</domain_knowledge>", "", "<observed_ui>", materials[1]!.text, "</observed_ui>"].join("\n");

const gateway = new RunGateway();
/**
 * `--run <runId>`：接着一条已经冻结过模块树的运行继续跑 stories。
 * 没有它的话，stories 那一步失败一次就要重新调一遍 modules——两分钟的推理，重来一遍只为换一行代码。
 */
const resumeRun = arg("run");
const key = `arm-machine-${Date.now()}`;
const reg = resumeRun ? { runId: resumeRun } : await gateway.register(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
  materials, parameters: { stageControlVersion: 1 } }) as { runId: string };
const runId = reg.runId;
if (resumeRun) {
  const { adapterRunGrant } = await import("../src/runService.js");
  gateway.adoptGrant(projectId, runId, adapterRunGrant(runId, projectId));
}
const log: Record<string, unknown> = { runId, arm: "machine", model: conn.model, think };

// ── modules ────────────────────────────────────────────────────────────────
let frozenTree: Array<{ id: string; name?: string; parentId?: string | null }> = [];
if (!resumeRun) {
await gateway.call(runId, "begin-stage", { node: "modules" });
const modulePrompt = ["你是这次运行的规划器（宿主模型）。当前节点：modules。", "",
  "工作流对这一步的要求（来自 testpilot-run-c 技能）：", step(4), "",
  "plan_modules 工具的契约：", toolDesc("plan_modules"), "",
  `材料分段：${sectionNote}。`,
  '只回 JSON：{"modules":[...],"outOfScope":[...]}，不要散文、不要 markdown 围栏。',
  "modules 每一项：{id, name, parentId|null, purpose, evidence:[段 id]}。", "", corpus].join("\n");
const modulesOut = await ask(modulePrompt);
let written = await gateway.call(runId, "stages/modules", { content: modulesOut.parsed }) as Record<string, any>;
log.modules = { usage: modulesOut.usage, ms: modulesOut.ms, written, proposal: modulesOut.parsed };
console.log("modules:", written.status, (modulesOut.parsed.modules ?? []).length, "模块 · 推理", modulesOut.usage?.reasoning_tokens);
if (written.status !== "validated") { writeFileSync(join(out, "machine-arm.json"), JSON.stringify(log, null, 2)); process.exit(1); }

frozenTree = modulesOut.parsed.modules ?? [];
}
if (!freezeAsOperator) {
  writeFileSync(join(out, "machine-arm.json"), JSON.stringify(log, null, 2));
  console.log("停在人冻结那一步。要继续跑 stories，去界面上按「冻结这棵模块树」，或加 --freeze-as-operator。");
  process.exit(0);
}
// 冻结路由只收不带 Authorization 头的请求：这里用裸 fetch，不走 gateway 的 run 令牌。
const freeze = resumeRun ? { skipped: true } : await (await fetch(`http://127.0.0.1:5301/api/projects/${projectId}/workflow-runs/${runId}/modules/freeze`,
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
log.freeze = freeze;
console.log("freeze:", JSON.stringify(freeze));

// ── stories ────────────────────────────────────────────────────────────────
// `stageControlVersion:1` 的 run 上，每个节点都要先 begin——instructions 也算一个节点。
await gateway.call(runId, "begin-stage", { node: "instructions" });
await gateway.call(runId, "stages/instructions", {});
await gateway.call(runId, "stages/retrieve", { query: "永续合约交易页的模块与用户任务", budgetTokens: 4000 });
const begun = await gateway.call(runId, "begin-stage", { node: "stories" }) as { structureContract?: string; moduleIds?: string[] };
const tree = frozenTree as Array<{ id: string; name?: string; parentId?: string | null; purpose?: string }>;
const storyPrompt = ["你是这次运行的规划器（宿主模型）。当前节点：stories。", "",
  "工作流对这一步的要求（来自 testpilot-run-c 技能）：", step(5), "",
  "服务端下发的结构契约：", begun.structureContract ?? "（无）", "", "",
  "**模块树已经由人冻结，不能改**。服务端交下来的 moduleIds 就是允许的全部取值，逐字照抄：",
  JSON.stringify(begun.moduleIds ?? tree.map((m) => m.id)), "",
  "这棵树的形状（写 modules 时照这个填 parentId）：",
  ...tree.map((m) => `  ${m.id}${m.parentId ? ` (parent ${m.parentId})` : ""} — ${m.name ?? ""}`), "",
  `材料分段：${sectionNote}。`,
  '只回 JSON：{"modules":[...],"stories":[...]}，modules 原样抄上面这棵树（每项 {id,name,parentId,kind}，kind 为 module 或 submodule），不要散文、不要围栏。',
  "stories 每一项：{id, title, role, benefit, moduleIds:[...], acceptance:[...], featureRefs:[], ruleRefs:[], source}。",
  "acceptance 每条写清前置、触发、业务结果，能被独立核对。", "", corpus].join("\n");
const storiesOut = await ask(storyPrompt);
const payload = { origin: "host", flows: [], derivedFrom: "exploration",
  modules: (storiesOut.parsed.modules ?? tree).map((m: any) => ({ id: m.id, name: m.name ?? m.id, parentId: m.parentId ?? undefined,
    kind: m.parentId ? "submodule" : "module", flowIds: [], routes: [] })),
  stories: storiesOut.parsed.stories ?? [] };
let stories = await gateway.call(runId, "stages/stories", { content: payload }) as Record<string, any>;
/**
 * 被拒之后修一轮——和 modules 那一步同一个口径。
 *
 * 2026-09-12 实测这一轮不是可选的：第一次提交时模型把**冻结的模块树整棵扔了**，
 * 拿 21 个材料段的 id 当模块，15 条故事全挂在段 id 上。提示词里已经把树逐行列出来并写了
 * 「只能取下面这些 id」，它照样换了一棵。挡住它的是服务端，不是话术。
 */
let storyRepair: unknown;
/**
 * 通过了也可能要补一轮：服务端把「哪几个叶子一条故事都没有」回给了规划器。
 *
 * 这不是拒收，是账单——规划器在 modules 节点切出来的每个叶子，都要在这里兑现两条故事。
 * 真实的循环会读这份回执然后补写，所以这里也读。
 */
if (stories.status === "validated" && Array.isArray(stories.modulePlan) && stories.modulePlan.length) {
  const empty = (stories.modulePlan as Array<{ code: string; moduleId?: string }>)
    .filter((f) => f.code === "leaf_without_story").map((f) => f.moduleId!).filter(Boolean);
  if (empty.length) {
    const again = await ask([storyPrompt, "",
      `上一版通过了校验，但服务端指出这 ${empty.length} 个叶子模块一条故事都没有：`, JSON.stringify(empty),
      "为它们每个补至少两条故事，其余故事原样保留，重发完整 JSON。"].join("\n"));
    storyRepair = { kind: "fill-empty-leaves", empty: empty.length, usage: again.usage, ms: again.ms };
    const filled = { ...payload, stories: again.parsed.stories ?? payload.stories };
    const out2 = await gateway.call(runId, "stages/stories", { content: filled }) as Record<string, any>;
    if (out2.status === "validated") { stories = out2; Object.assign(payload, filled); }
    console.log("stories(补空叶子):", out2.status, (filled.stories ?? []).length, "条 · 仍空",
      ((out2.modulePlan ?? []) as Array<{ code: string }>).filter((f) => f.code === "leaf_without_story").length);
  }
}
if (stories.status === "blocked") {
  const errs = (stories.errors ?? []) as Array<{ jsonPointer: string; message: string }>;
  const again = await ask([storyPrompt, "", "上一版被服务端拒收。moduleIds 只能取上面列出的模块 id，不是材料段 id。逐条修掉之后重发完整 JSON：",
    ...errs.slice(0, 12).map((e) => `- ${e.jsonPointer}: ${e.message}`)].join("\n"));
  storyRepair = { usage: again.usage, ms: again.ms };
  const fixed = { ...payload, modules: (again.parsed.modules ?? tree).map((m: any) => ({ id: m.id, name: m.name ?? m.id,
    ...(m.parentId ? { parentId: m.parentId } : {}), kind: m.parentId ? "submodule" : "module", flowIds: [], routes: [] })),
    stories: again.parsed.stories ?? [] };
  stories = await gateway.call(runId, "stages/stories", { content: fixed }) as Record<string, any>;
  Object.assign(payload, fixed);
  console.log("stories(修复后):", stories.status, (fixed.stories ?? []).length, "条");
}
log.stories = { usage: storiesOut.usage, ms: storiesOut.ms, repair: storyRepair, written: stories, payload };
console.log("stories:", stories.status, (payload.stories ?? []).length, "条 · 推理", storiesOut.usage?.reasoning_tokens);
writeFileSync(join(out, "machine-arm.json"), JSON.stringify(log, null, 2));
