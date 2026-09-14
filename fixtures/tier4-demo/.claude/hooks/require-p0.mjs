#!/usr/bin/env node
/**
 * Stop hook：P0 没绿不许结束回合（07 T-15）。
 * 读 `.claude/project.json` 里的 projectId，调网关跑这个项目的 P0；有红就 `{"decision":"block","reason":…}`，
 * reason 点名哪条红、判据读到了什么。判决由机器判据下，这个 hook 不看模型说了什么。
 * 拦截也记进 `.claude/holds.jsonl`（和 TestPilot 的 holds 同一套词：gate=p0）。
 * 只在**这次会话改过文件**时才跑（transcript 里有 Write/Edit）；纯聊天不拦。封顶 3 次，免得来回拉扯烧钱。
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
if (msg.hook_event_name !== "Stop") process.exit(0);
const cfgPath = join(here, "..", "project.json");
if (!existsSync(cfgPath)) process.exit(0);
const { projectId, gateway = "http://127.0.0.1:5301" } = JSON.parse(readFileSync(cfgPath, "utf8"));
// 这次会话有没有改过文件
let edited = false;
if (msg.transcript_path && existsSync(msg.transcript_path))
  for (const line of readFileSync(msg.transcript_path, "utf8").split("\n")) if (/"name":"(Write|Edit|MultiEdit)"/.test(line)) { edited = true; break; }
if (!edited) process.exit(0);
const stateDir = join(here, "..", ".state"); mkdirSync(stateDir, { recursive: true });
const safeSession = String(msg.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0,128);
const stateFile = join(stateDir, `${safeSession}.json`);
const record = (status, reason, extra = {}) => { const value = { at:new Date().toISOString(),status,reason,allowMerge:false,session:safeSession,...extra }; writeFileSync(stateFile,JSON.stringify({...value,nudges:n})); appendFileSync(join(here,"..","holds.jsonl"),JSON.stringify(value)+"\n"); };
let n = 0; try { n = JSON.parse(readFileSync(stateFile, "utf8")).nudges ?? 0; } catch {}
if (n >= 3) { record("blocked","retry_budget_exhausted"); process.stderr.write("P0 blocked: retry budget exhausted. Conversation may stop; merge approval is not granted.\n"); process.exit(0); }
let result;
try {
  const r = await fetch(`${gateway}/api/projects/${projectId}/suite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: "P0", retries: 0 }), signal: AbortSignal.timeout(20 * 60_000) });
  result = await r.json();
  if (!r.ok) throw new Error(result.error || `HTTP ${r.status}`);
} catch (e) {
  // 网关不在 = 没法证明绿，也不能证明红：不拦，但说出来。
  record("blocked","gateway_unavailable"); process.stderr.write("P0 blocked: gateway unavailable. Conversation may stop; merge approval is not granted.\n"); process.exit(0);
}
const red = (result.items || []).filter((it) => it.status !== "passed");
if (!Array.isArray(result.items) || result.items.length === 0) { record("blocked","no_p0_results"); process.exit(0); }
if (!red.length) { record("passed","advisory_suite_passed"); process.exit(0); }
const details = [];
for (const it of red) {
  let why = it.status;
  if (it.runId) { try { const run = (await (await fetch(`${gateway}/api/runs/${it.runId}`)).json()).run; const o = (run?.oracle || []).find((x) => x.status !== "pass"); why = o ? `${o.status}：${o.detail}` : (run?.failureReason || it.status).slice(0, 160); } catch {} }
  details.push(`「${it.caseTitle}」${why}`);
}
n += 1; record(red.some(it => ["infra_error","error","blocked","unobservable"].includes(it.status)) ? "blocked" : "failed", "p0_not_green", { details });
appendFileSync(join(here, "..", "holds.jsonl"), JSON.stringify({ at: new Date().toISOString(), hook: "require-p0", gate: "p0", session: msg.session_id, red: red.length, details }) + "\n");
process.stdout.write(JSON.stringify({ decision: "block", reason: `P0 有 ${red.length} 条没绿，不能结束：${details.join("；")}。修好再试；判决来自接口判据，不是我说的。` }));
