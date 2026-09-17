/**
 * **只重跑 stories + cases 两个节点**，其余一切不动。
 *
 * 2026-09-13 量出的那条闭合链（docs/v3/history/24 §38）：`acRefs` 收自由文本 → 模型改写验收准则
 * （85 条里 21 条，16 条连 When 都换了）→ 用例不需要动作（81 条里 24 条只有导航和看）→
 * 判据退化成「页面上有这个字面量」→ 在初始页面上就成立 → 通过时什么都没证明。
 * 契约与服务端已经从两头堵上，这一趟量的就是**堵上之后模型写出来的东西变不变**。
 *
 * 为什么不整份重跑：材料是一份 187k 字的 `exploration.md`，重新探索是几小时加一次钱包会话，
 * 而这次要换的只有两个节点的契约。所以：
 *   - 材料原样带过来（同一份 exploration.md，同一个规则包）；
 *   - 产品模型用 `importProductModel` 直接导入，`sourceKind: 'spec'` 不触发探索；
 *   - 模块树**逐字照抄上一次人工冻结的那棵**——树不变，故事和用例才有可比性。
 * 只有 stories 与 cases 是模型现写的。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!;
const fromRun = arg("from")!;
const out = resolve(arg("out") ?? join(root, "docs/v3/evidence/rerun-2026-09-14"));
mkdirSync(out, { recursive: true });
const maxTokens = Number(arg("maxTokens") ?? 40000);
const base = arg("base") ?? "http://127.0.0.1:5301";

const { runLedger } = await import("../src/runService.js");
const { projectModelConnection } = await import("../src/modelProfiles.js");
const l = runLedger();
const latest = (name: string) => l.listRevisions(projectId, fromRun).filter((r: any) => r.name === name).sort((a: any, z: any) => a.revision - z.revision).at(-1);

const model = l.readRevision(latest("product/model-candidate")!.id, projectId).content as any;
const packRev = l.listRevisions(projectId, fromRun).find((r: any) => r.name.startsWith("knowledge/rulepack/"))!;
const pack = (l.readRevision(packRev.id, projectId).content as any).rulePack;
const material = l.readRevision(latest("exploration.md")!.id, projectId).content as string;
const frozenRaw = l.readRevision(latest("validated/modules")!.id, projectId).content as any;
// 落盘的产物带着机检结果（findings/sections），提案 schema 是 strict 的——只把树本身交回去。
const frozenTree = {
  modules: (frozenRaw.modules ?? []).map((m: any) => ({ id: m.id, name: m.name, parentId: m.parentId ?? null,
    purpose: m.purpose, evidence: m.evidence ?? [], featureIds: m.featureIds ?? [] })),
  outOfScope: (frozenRaw.outOfScope ?? []).map((o: any) => ({ sectionId: o.sectionId, reason: o.reason })),
};
console.log(`带过来：产品模型 ${model.features?.length} 个功能 · 规则包 ${pack.rules.length} 条 · 材料 ${material.length} 字符 · 冻结的树 ${frozenTree.modules.length} 个模块`);

const conn = projectModelConnection(projectId, "planner");
async function ask(user: string) {
  const t0 = Date.now();
  const res = await fetch(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: "system", content: "只回 JSON。" }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const json = await res.json() as any;
  const raw = json.choices?.[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  return { parsed: m ? JSON.parse(m[0]) : {}, usage: json.usage, ms: Date.now() - t0, http: res.status };
}

/**
 * `--resume <runId>`：接着一次已经建好的运行往下跑。
 *
 * 2026-09-14 用上了一次——我把正在跑的驱动误当成三个并发进程杀掉了（那其实是
 * npm exec → tsx → node 同一条进程链）。故事侧已经落盘，没有理由为了继续 cases 重跑一遍。
 * 单元循环本来就是可续的：服务端记着每个单元的状态，领到什么写什么。
 */
const resumeRun = arg("resume");
/**
 * `--stories-from <runId>`：把那次运行已冻结的故事直接导入，**只跑 cases**。
 *
 * 2026-09-14 用上了一次：故事侧已经写好了（38 条），而要换的是用例契约里
 * 「哪几条准则要用户动手」那份标注——动作动词表调了三轮。没有理由为了重跑用例
 * 再让模型写一遍故事：`importStories` 这条路本来就在（它要求 workUnits）。
 */
const storiesFrom = arg("stories-from");
const importedStories = storiesFrom
  ? (l.readRevision(l.listRevisions(projectId, storiesFrom).filter((r: any) => r.name === "validated/stories").at(-1)!.id, projectId).content as any)
  : undefined;
if (importedStories) console.log(`导入故事：${importedStories.stories.length} 条（来自 ${storiesFrom}）`);
const key = `rerun-${Date.now()}`;
const created = resumeRun ? { wfRunId: resumeRun } : await (await fetch(`${base}/api/projects/${projectId}/workflow-runs`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ idempotencyKey: key, sourceKind: "spec", outputLanguage: "zh", workUnits: true,
    materials: [{ name: "exploration.md", text: material }], rulePacks: [pack], importProductModel: model,
    ...(importedStories ? { importStories: importedStories } : {}),
    targetUrl: "https://app.hyperliquid-testnet.xyz/trade" }),
})).json() as any;
const runId = created.wfRunId as string;
console.log("新运行:", runId, JSON.stringify(created).slice(0, 160));
if (!runId) process.exit(1);

/**
 * 直接带写入凭证调 HTTP，而不是走 `RunGateway`。
 *
 * 网关只认**它自己注册过**的 run（`run_not_registered_in_this_mcp_session`），
 * 而这次的 run 必须由 Web API 建——只有那条路收 `importProductModel`，
 * 也只有导入产品模型才能跳过重新探索。凭证用 `adapterRunGrant` 就地铸一张。
 */
const { adapterRunGrant } = await import("../src/runService.js");
const token = adapterRunGrant(runId, projectId);
const gateway = {
  async call(_runId: string, path: string, body: unknown) {
    const res = await fetch(`${base}/api/projects/${projectId}/workflow-runs/${runId}/${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(35 * 60_000),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { status: `http_${res.status}`, body: text.slice(0, 300) }; }
  },
};
const log: Record<string, unknown> = { runId, from: fromRun, at: new Date().toISOString() };

// 模块：逐字照抄上一次冻结的那棵，不问模型。树不变，故事和用例才有可比性。
if (!resumeRun) {
await gateway.call(runId, "begin-stage", { node: "modules" });
const mw = await gateway.call(runId, "stages/modules", { content: frozenTree }) as any;
console.log("modules:", mw.status, mw.errors ? JSON.stringify(mw.errors).slice(0, 300) : "");
if (mw.status !== "validated") { writeFileSync(join(out, "rerun.json"), JSON.stringify({ ...log, modules: mw }, null, 2)); process.exit(1); }
console.log("freeze:", JSON.stringify(await (await fetch(`${base}/api/projects/${projectId}/workflow-runs/${runId}/modules/freeze`,
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).slice(0, 200));

await gateway.call(runId, "begin-stage", { node: "instructions" });
await gateway.call(runId, "stages/instructions", {});
await gateway.call(runId, "stages/retrieve", { query: "永续合约交易页的模块与用户任务", budgetTokens: 4000 });
}

const skill = readFileSync(join(root, "plugins/testpilot/skills/testpilot-run-c/SKILL.md"), "utf8");
const step = (n: number) => skill.split("\n").find((line) => line.startsWith(`${n}. `))!;
const sectionNote = `exploration.md: ${material.split("\n").filter((line) => /^##\s+\S/.test(line) || /^=====/.test(line)).length} 段`;
const corpus = ["<observed_ui>", material, "</observed_ui>"].join("\n");

/** 一个节点的单元循环：服务端拆单元、规划器一次只领一个，契约原样交给模型。 */
async function unitLoop(node: "stories" | "cases", maxRounds: number) {
  const begun = await gateway.call(runId, "begin-stage", { node }) as { structureContract?: string };
  const rounds: unknown[] = [];
  for (let i = 0; i < maxRounds; i++) {
    const claimed = await gateway.call(runId, "stages/units/claim", { node }) as any;
    if (!claimed.unit) { log[`${node}Merged`] = claimed.merged ?? claimed.instruction; break; }
    const res = await ask([
      `你是这次运行的规划器。当前节点：${node}。**这一轮只写一个单元**：`, claimed.unit.unitId, "",
      "工作流要求：", step(node === "stories" ? 5 : 6), "",
      "结构契约：", begun.structureContract ?? "", "",
      "这个单元的指令：", claimed.instruction ?? "", "",
      "这个单元的材料：", JSON.stringify(claimed.materials ?? {}).slice(0, 60000), "",
      `材料分段：${sectionNote}。`,
      node === "stories"
        ? '只回 JSON：{"stories":[...]}；每项 {id,title,role,benefit,moduleIds,acceptance,source}。'
        : '只回 JSON：{"cases":[...]}。',
      "", corpus,
    ].join("\n"));
    const w = await gateway.call(runId, "stages/units/write", { unitId: claimed.unit.unitId, content: res.parsed }) as any;
    const n = (res.parsed.stories ?? res.parsed.cases ?? []).length;
    const status = w.status ?? (w.errors ? "blocked" : w.revisionId ? "written" : JSON.stringify(w).slice(0, 40));
    rounds.push({ unitId: claimed.unit.unitId, status, n, usage: res.usage, ms: res.ms, errors: w.errors?.slice?.(0, 6) });
    console.log(`  ${claimed.unit.unitId}: ${status} · 模型给 ${n} 条 · ${Math.round(res.ms / 1000)}s${w.errors ? " · " + JSON.stringify(w.errors.slice(0, 3)).slice(0, 220) : ""}`);
    if (w.merged) log[`${node}Merged`] = w.merged;
    writeFileSync(join(out, "rerun.json"), JSON.stringify({ ...log, [node]: rounds }, null, 2));
  }
  log[node] = rounds;
  return rounds;
}

if (!resumeRun && !importedStories) { console.log("\n--- stories ---"); await unitLoop("stories", 24); }
console.log("\n--- cases ---");
await unitLoop("cases", 60);

console.log("\n--- gate ---");
await gateway.call(runId, "begin-stage", { node: "gate" });
const gate = await gateway.call(runId, "stages/gate", {}) as any;
log.gate = { status: gate.status, score: gate.report?.score, findings: gate.report?.findings?.length };
console.log("gate:", JSON.stringify(log.gate));
writeFileSync(join(out, "rerun.json"), JSON.stringify(log, null, 2));
console.log("\nrunId", runId);
