/**
 * 消融：整份写入 vs 单元循环。
 *
 * 唯一的自变量是**规划器一次看到多少**：整份臂一次拿到全部功能、规则、观察（以及写用例时
 * 全部故事），单元臂一次只拿一个单元的范围。材料、模型、温度、契约措辞全一样。
 *
 * 它要回答的是这个 loop 的核心主张——「拆了之后产物更好」。此前所有对比都是 loop 对 loop，
 * 这句话一次都没被验证过（docs/v3/23 §19）。
 */
import { config } from "dotenv";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!, runId = arg("run")!;
const out = resolve(arg("out") ?? join(root, "docs/v3/evidence/hl-round2-2026-09-11/ablation"));
mkdirSync(out, { recursive: true });
const samples = Number(arg("n") ?? 1);
const maxTokens = Number(arg("maxTokens") ?? 16000);

const { unitMaterials } = await import("../src/workUnits.js");
const { runLedger } = await import("../src/runService.js");
const { projectModelConnection } = await import("../src/modelProfiles.js");
const { StorySchema, TextCaseSchema, checkDesignEvidence, runGate } = await import("@testpilot/harness-testing/casegen");

const l = runLedger();
const whole = unitMaterials(runId, projectId, { runId, unitId: "whole", node: "cases", scope: { kind: "all" }, order: 0, dependsOn: [], status: "pending", attempt: 0, updatedAt: "" } as never);
const storiesRev = l.listRevisions(projectId, runId).filter((r) => r.name === "validated/stories").sort((a, b) => a.revision - b.revision).at(-1)!;
const stories = (l.readRevision(storiesRev.id, projectId).content as { stories: unknown[] }).stories;

const conn = projectModelConnection(projectId, "planner");
/**
 * 用 node:https 而不是 fetch：整份臂一次要生成 4 万 token，耗时超过 undici 默认的
 * 300 秒 headers 超时，fetch 会在模型还在写的时候把连接掐掉（UND_ERR_HEADERS_TIMEOUT）。
 * 这不是模型的问题，是客户端的默认值——量一次「整份写入要多久」不能被它截断。
 */
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
    req.setTimeout(30 * 60_000, () => { req.destroy(new Error("REQUEST_TIMEOUT_30MIN")); });
    req.on("error", fail);
    req.end(body);
  });
}
async function ask(system: string, user: string) {
  const t0 = Date.now();
  const body = JSON.stringify({ model: conn.model, temperature: 0, max_tokens: maxTokens, reasoning_effort: "none",
    messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  const text = await post(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`, body,
    { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}` });
  const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, number>; error?: unknown };
  return { text: json.choices?.[0]?.message?.content ?? "", finish: json.choices?.[0]?.finish_reason, usage: json.usage, error: json.error, ms: Date.now() - t0, inputChars: system.length + user.length };
}
const parse = (t: string) => { const m = t.match(/\{[\s\S]*\}/); if (!m) return { parseError: "no_json" as const }; try { return JSON.parse(m[0]) as Record<string, unknown>; } catch (e) { return { parseError: String(e).slice(0, 120) }; } };

const CASE_CONTRACT = [
  "Write the test cases for EVERY story below, in one reply, as {cases:[...]}.",
  "REQUIRED on every case, or the write is rejected: id, storyId (one of the stories below), title, designMethod, steps[], expected, tier, key, priority, scenarioType.",
  "  designMethod ∈ equivalence | boundary | state-transition | decision-table | negative | exploratory, and it must agree with design.technique.",
  "  key is a dedupe triple 'transition|parameters|assertion'. steps are short end-agnostic actions. priority takes the rule's riskFloor as its lower bound.",
  "  expected is ONE independently checkable result, phrased for a person to read.",
  "acRefs and conditionRefs are NOT optional decoration: acRefs says which acceptance criteria the case discharges, conditionRefs which test conditions it covers.",
  "tier and oracle move together. tier 1 or 2 REQUIRES a machine-checkable oracle on the case or on at least one assertion.",
  '    {"kind":"text","value":"<literal>"}   {"kind":"noText","value":"<literal>"}   {"kind":"count","value":"<literal>","op":"eq|gte|lte","n":<int>}',
  '    {"kind":"api","url":"<endpoint>","method":"POST","body":"<json string>","path":"<dotted path>","op":"eq|exists|absent|increased|decreased","value":<optional>}',
  "  An api oracle is evaluated by the runner, NOT by the browser agent. steps drive the PAGE only.",
  "covers must be exactly the transition ids in design.transitionIds. A rule id (R-…) is NOT a transition.",
  "  • Two axes, never mixed. scenarioType ∈ positive | negative | recovery | concurrency. design.technique ∈ equivalence | boundary | decision-table | state-transition | exploratory. `negative` is a scenario and never a technique.",
  "  • design.technique is REQUIRED inside design and must equal designMethod.",
  "  • risk: {impact, reason, ruleRefs}. impact is one of funds-and-exposure | authorization | data-integrity | availability | information | cosmetic.",
  "  • testData is an OBJECT: {fixtureRef?, accountRef?, values:[{name, value, unit?, source?}]}. Never invent a constant.",
  "  • assertions: {id, statement, ruleRefs[], oracle?} — the field is `statement`, not `expected`.",
  "  • readiness: {design, execution, reason?}. design ∈ candidate | reviewed. execution ∈ ready | requires-fixture | requires-session | blocked | not-executable.",
  "postSteps put the product back. Any case that changes state MUST say how it undoes that.",
  "Do not lower a P0 because a fixture is missing; keep the case, mark readiness.execution and say why.",
].join("\n");

function profile(raw: unknown[]) {
  const parsed = raw.map((c) => TextCaseSchema.safeParse(c));
  const ok = parsed.flatMap((p) => (p.success ? [p.data] : []));
  const v2 = ["acRefs", "conditionRefs", "scenarioType", "design", "risk", "testData", "assertions", "readiness"] as const;
  const gate = runGate({ stories: stories as never, cases: ok, flows: [] } as never, { minNegativeRatio: 0.3 });
  return {
    produced: raw.length, schemaValid: ok.length,
    schemaErrors: [...new Set(parsed.flatMap((p) => (p.success ? [] : [String(p.error.issues[0]?.path.join("/")) + ": " + p.error.issues[0]?.message])))].slice(0, 6),
    storiesCovered: new Set(ok.map((c) => c.storyId)).size,
    withOracle: ok.filter((c) => c.oracle || (c.assertions ?? []).some((a) => a.oracle)).length,
    tierClaimedNoOracle: ok.filter((c) => c.tier < 3 && !c.oracle && !(c.assertions ?? []).some((a) => a.oracle)).length,
    v2Fields: Object.fromEntries(v2.map((k) => [k, ok.filter((c) => c[k] !== undefined).length])),
    evidenceErrors: checkDesignEvidence(ok).length,
    gateScore: Number(gate.score.toFixed(4)), gateWarns: gate.findings.filter((f) => f.severity === "warn").length,
  };
}

/**
 * 整份臂也要有**同样的反馈回路**，否则比的不是「拆没拆」，是「有没有人告诉它错了」。
 *
 * 单元臂被拒一次就拿到一次带 jsonPointer 的错误再写；整份臂原来只有一发。这里给它
 * 同样的机会：把 schema 错误逐条喂回去，最多 `--rounds` 轮，每轮都记账。
 */
const MAX_ROUNDS = Number(arg("rounds") ?? 3);
const SYSTEM = "You are a senior test designer. Reply with JSON only: {\"cases\":[...]}. No prose, no markdown fence.";
const baseUser = [CASE_CONTRACT, "", "<stories>", JSON.stringify(stories, null, 1), "</stories>", "",
  "<product_model>", JSON.stringify(whole, null, 1), "</product_model>"].join("\n");

function schemaErrors(raw: unknown[]) {
  const errs: string[] = [];
  raw.forEach((c, i) => {
    const p = TextCaseSchema.safeParse(c);
    if (!p.success) for (const issue of p.error.issues.slice(0, 2))
      errs.push(`cases[${i}] (${(c as { id?: string }).id ?? "?"}) /${issue.path.join("/")}: ${issue.message}`);
  });
  return errs;
}

const results: Record<string, unknown>[] = [];
for (let i = 0; i < samples; i++) {
  const rounds: Record<string, unknown>[] = [];
  let user = baseUser, cases: unknown[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await ask(SYSTEM, user);
    const p = parse(r.text);
    cases = Array.isArray(p.cases) ? (p.cases as unknown[]) : [];
    const prof = profile(cases);
    const errs = schemaErrors(cases);
    rounds.push({ round, ...prof, finish: r.finish, ms: r.ms, inputChars: r.inputChars, outputChars: r.text.length, usage: r.usage,
      parseError: (p as { parseError?: string }).parseError, error: r.error });
    writeFileSync(join(out, `whole-cases-${i + 1}-r${round}.json`), JSON.stringify({ raw: r.text, parsed: p, errors: errs.slice(0, 40) }, null, 2));
    console.log(JSON.stringify(rounds.at(-1)));
    if (!errs.length && !(p as { parseError?: string }).parseError) break;
    user = [baseUser, "", `REPAIR ROUND ${round}. Your previous reply did not pass the schema. Fix exactly these and reply with the WHOLE {cases:[...]} again:`,
      ...errs.slice(0, 40).map((e) => `  • ${e}`),
      "Fixing by deleting the field is not a fix. Keep every case; correct the shape."].join("\n");
  }
  results.push({ sample: i + 1, rounds });
}
writeFileSync(join(out, "whole-summary.json"), JSON.stringify({ model: conn.model, stories: stories.length, maxTokens, maxRounds: MAX_ROUNDS, results }, null, 2));
