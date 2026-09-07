#!/usr/bin/env node
/**
 * 把一批跑完的评测运行录成 `recordings/<caseId>.json`，然后回放打分。
 *
 * 输入是一份 launch 清单（`eval-sessions.json`）：每项 `{ case, runId, workspace, launch: { sessionId } }`。
 * trace 按 sessionId 在 `<agent>/traces/<日期>/session-…_001.jsonl` 里找。录制只是三个绝对路径加版本；
 * 打分全在 `evalcase.ts`，这里不重复任何规则。
 *
 * 用法：node scripts/eval-record.mjs <eval-sessions.json> <capability> [--baseline]
 *   --baseline  把这次的 (caseId, scorer) 结果写成 recordings/baseline.json（宣告「这是新的基线」）
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [listPath, cap = "binance-futures"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const WRITE_BASELINE = process.argv.includes("--baseline");
if (!listPath) {
  console.error("用法：node scripts/eval-record.mjs <eval-sessions.json> <capability> [--baseline]");
  process.exit(2);
}

const req = createRequire(pathToFileURL(path.join(ROOT, "packages/testpilot-mcp/package.json")));
const { register } = await import(pathToFileURL(req.resolve("tsx/esm/api")).href);
register();
const { replay, diffBaseline } = await import(pathToFileURL(path.join(ROOT, "packages/testpilot-mcp/src/evalcase.ts")).href);

const list = JSON.parse(readFileSync(listPath, "utf8"));
const capDir = path.join(ROOT, "benchmark", cap);
const recDir = path.join(capDir, "recordings");
mkdirSync(recDir, { recursive: true });
const plugin = JSON.parse(readFileSync(path.join(ROOT, "plugins/testpilot/plugin.json"), "utf8"));

/** `<workspace>/../../traces/<date>/session-<id>_NNN.jsonl`：agent 目录在 workspace 上两级。 */
function traceFor(workspace, sessionId) {
  const agentDir = path.resolve(workspace, "..", "..");
  const tracesRoot = path.join(agentDir, "traces");
  if (!existsSync(tracesRoot)) return undefined;
  for (const day of readdirSync(tracesRoot).sort().reverse()) {
    const dir = path.join(tracesRoot, day);
    const hit = readdirSync(dir).filter((f) => f.startsWith(sessionId) && f.endsWith(".jsonl")).sort();
    if (hit.length) return path.join(dir, hit[hit.length - 1]);
  }
  return undefined;
}

const idOf = { honest: "honest-run", poison: "poisoned-material", forgery: "meta-forgery" };
for (const item of list) {
  const sid = item.launch?.sessionId;
  const caseId = idOf[item.case] ?? item.case;
  const trace = sid ? traceFor(item.workspace, sid) : undefined;
  if (!trace) {
    console.error(`${caseId}: 找不到 session ${sid} 的 trace，跳过`);
    continue;
  }
  const runDir = path.join(item.workspace, "runs", item.runId);
  const rec = {
    caseId,
    at: new Date().toISOString(),
    workspace: item.workspace,
    runDir: existsSync(runDir) ? runDir : undefined,
    tracePath: trace,
    skillVersion: plugin.skillVersions["testpilot-run-c"],
    sessionId: sid,
  };
  writeFileSync(path.join(recDir, `${caseId}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`${caseId}: recorded (runDir ${rec.runDir ? "yes" : "MISSING"}, trace ${path.basename(trace)})`);
}

const report = replay(path.join(capDir, "cases"), recDir);
for (const r of report.results) {
  console.log(`\n${r.caseId}: ${r.status.toUpperCase()}`);
  for (const s of r.results) console.log(`  ${s.pass ? "✓" : "✗"} ${s.scorer}  ${s.detail}`);
}
if (report.pending.length) console.log(`\npending（无录制）: ${report.pending.join(", ")}`);

const basePath = path.join(recDir, "baseline.json");
if (existsSync(basePath)) {
  const prev = JSON.parse(readFileSync(basePath, "utf8"));
  const d = diffBaseline(prev, report.keyed);
  console.log(`\n对上次基线：新红 ${d.newlyFailing.length}（${d.newlyFailing.join(", ") || "—"}），新绿 ${d.newlyPassing.length}（${d.newlyPassing.join(", ") || "—"}）`);
}
if (WRITE_BASELINE) {
  writeFileSync(basePath, JSON.stringify(report.keyed, null, 2) + "\n");
  console.log("baseline.json 已写");
}
