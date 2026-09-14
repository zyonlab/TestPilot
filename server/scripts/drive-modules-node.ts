/**
 * 让规划器在**自己的循环里**跑一次 `modules` 节点。
 *
 * 和 `plan-modules-ab.ts` / `submit-module-plan.ts` 的关键差别：提示词不是我为这次实验
 * 手调的 V2 契约，而是**产品里真正下发的那两段文本**——`plugins/testpilot/skills/testpilot-run-c/SKILL.md`
 * 的模块规划那一步，加上 MCP 工具 `plan_modules` 的 description。两段都从文件里逐字读出来拼，
 * 不在这里重写。所以这一趟回答的是：**出厂的话术够不够用**，而不是「我调的话术行不行」。
 *
 * 走的是 MCP 的 `RunGateway`，和宿主规划器用的是同一段代码：注册 → begin_stage → plan_modules。
 * 跑完停在人冻结那一步，脚本不替人按。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!;
const maxTokens = Number(arg("maxTokens") ?? 40000);
const think = !process.argv.includes("--no-think");

const { RunGateway } = await import("testpilot-mcp/run-gateway");
const { projectModelConnection } = await import("../src/modelProfiles.js");

/** 出厂话术：SKILL.md 的那一步 + 工具 description，逐字取。 */
function shippedContract(): { step: string; tool: string } {
  const skill = readFileSync(join(root, "plugins/testpilot/skills/testpilot-run-c/SKILL.md"), "utf8");
  const step = skill.split("\n").find((l) => l.startsWith("4. ")) ?? "";
  const server = readFileSync(join(root, "packages/testpilot-mcp/src/server.ts"), "utf8");
  const tool = server.split('server.registerTool("plan_modules"')[1]!.split("inputSchema")[0]!
    .match(/description:\s*"((?:[^"\\]|\\.)*)"/)![1]!.replace(/\\"/g, '"');
  if (!step || !tool) throw new Error("shipped contract text not found");
  return { step, tool };
}

async function post(url: string, body: string, headers: Record<string, string>): Promise<string> {
  const { request } = await import("node:https");
  const u = new URL(url);
  return new Promise((ok, fail) => {
    const req = request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    });
    req.setTimeout(30 * 60_000, () => req.destroy(new Error("REQUEST_TIMEOUT")));
    req.on("error", fail);
    req.end(body);
  });
}

const materials = ["domain-perp-zh.md", "observed-zh.md"].map((name) =>
  ({ name, text: readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials", name), "utf8") }));
const gateway = new RunGateway();
const key = `drive-modules-${Date.now()}`;
const registered = await gateway.register(projectId, { runtime: "codex", externalId: key, idempotencyKey: key,
  materials, parameters: { workUnits: 1, stageControlVersion: 1 } }) as { runId: string };
const runId = registered.runId;
const begun = await gateway.call(runId, "begin-stage", { node: "modules" }) as { status: string };

const { step, tool } = shippedContract();
const sections = materials.map((m) => `${m.name}: ${m.text.split("\n").filter((l) => /^##\s+\S/.test(l)).length} 段，段 id 写成 ${m.name}#1 … ${m.name}#N`).join("；");
const user = [
  "你是这次运行的规划器（宿主模型）。当前节点：modules。",
  "",
  "工作流对这一步的要求（来自 testpilot-run-c 技能）：",
  step,
  "",
  "plan_modules 工具的契约：",
  tool,
  "",
  `材料分段：${sections}。`,
  "只回 JSON：{\"modules\":[...],\"outOfScope\":[...]}，不要散文、不要 markdown 围栏。",
  "modules 每一项：{id, name, parentId|null, purpose, evidence:[段 id]}。",
  "", "<domain_knowledge>", materials[0]!.text, "</domain_knowledge>",
  "", "<observed_ui>", materials[1]!.text, "</observed_ui>",
].join("\n");

const conn = projectModelConnection(projectId, "planner");
const t0 = Date.now();
const text = await post(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`,
  JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens, ...(think ? {} : { reasoning_effort: "none" }),
    messages: [{ role: "system", content: "只回 JSON。" }, { role: "user", content: user }] }),
  { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}` });
const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, any> };
const raw = json.choices?.[0]?.message?.content ?? "";
const m = raw.match(/\{[\s\S]*\}/);
const parsed = m ? JSON.parse(m[0]) as { modules?: unknown[]; outOfScope?: unknown[] } : {};

/**
 * 被拒之后修一轮。
 *
 * 单发一次不算「在循环里跑」：真实的规划器拿到 blocked 会按 jsonPointer 修了再调。
 * 这里照做一轮——两轮还修不好，那才是话术的问题，不是手滑。
 */
let written = await gateway.call(runId, "stages/modules", { content: parsed }) as Record<string, any>;
let repaired: Record<string, any> | undefined;
if (written.status === "blocked") {
  const repairPrompt = [user, "", "上一版被服务端拒收，逐条修掉之后重发完整 JSON：",
    ...(written.errors ?? []).map((e: { jsonPointer: string; message: string }) => `- ${e.jsonPointer}: ${e.message}`)].join("\n");
  const again = JSON.parse(await post(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`,
    JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens, ...(think ? {} : { reasoning_effort: "none" }),
      messages: [{ role: "system", content: "只回 JSON。" }, { role: "user", content: repairPrompt }] }),
    { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}` })) as typeof json;
  const rawAgain = again.choices?.[0]?.message?.content ?? "";
  const mAgain = rawAgain.match(/\{[\s\S]*\}/);
  repaired = mAgain ? JSON.parse(mAgain[0]) : {};
  written = await gateway.call(runId, "stages/modules", { content: repaired }) as Record<string, any>;
}
// 冻结是人的事：脚本到此为止，不替人按。
const state = await gateway.call(runId, "stages/modules/state", {}) as Record<string, any>;
/**
 * 树没冻结的时候往下走会怎样。
 *
 * 要先 begin 故事节点，否则挡住它的是 `begin_stage_required`——那是另一道闸门，
 * 证明不了「没冻结就不许切单元」这件事。
 */
let claimed: unknown;
try {
  await gateway.call(runId, "begin-stage", { node: "stories" });
  claimed = await gateway.call(runId, "stages/units/claim", { node: "stories" });
} catch (e) { claimed = String((e as Error).message); }

const out = { runId, begin: begun.status, contract: { step, tool }, prompt: user, usage: json.usage, ms: Date.now() - t0, raw, parsed, repaired, written, state, claimed };
writeFileSync(join(root, "docs/v3/evidence/module-plan-2026-09-11", "drive-modules-node.json"), JSON.stringify(out, null, 2));
const findings = (written.findings ?? []) as Array<{ code: string; severity: string }>;
const final = (repaired ?? parsed) as { modules?: unknown[]; outOfScope?: unknown[] };
console.log(JSON.stringify({ runId, begin: begun.status, status: written.status, repairRounds: repaired ? 1 : 0, modules: (final.modules ?? []).length,
  outOfScope: (final.outOfScope ?? []).length, reasoning: json.usage?.reasoning_tokens, ms: Date.now() - t0,
  errors: findings.filter((f) => f.severity === "error").length, warn: findings.filter((f) => f.severity === "warn").length,
  codes: [...new Set(findings.map((f) => f.code))], frozen: state.frozen, claimStories: claimed }, null, 1));
