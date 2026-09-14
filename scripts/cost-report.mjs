#!/usr/bin/env node
/**
 * 每条用例每次运行花了什么——执行层降本的那张表。
 *
 *   node scripts/cost-report.mjs                    # 所有项目，最近 200 次运行
 *   node scripts/cost-report.mjs --project prj-xxx  # 只看一个项目
 *   node scripts/cost-report.mjs --last 5           # 每条用例只取最近 5 次
 *   node scripts/cost-report.mjs --json             # 机器可读
 *
 * 读的是 `server/.data/testpilot.db`（或 TP_DATA_DIR）里 runs 表的 `spendJson`
 * （`packages/harness-testing/src/report.ts` 的 `RunSpend`）。
 *
 * 三条纪律：
 *   * 报中位数与散布，不只报均值——一次 90 秒的模型超时会把均值拖成假象。
 *   * 缓存三态分开报：命中 / 未命中 / 失效（有缓存但元素对不上）。第三档是自愈发生的地方，
 *     它高说明页面在变，不是模型在变。
 *   * 单价不猜。`TP_USD_PER_MTOK` 没设就只报 token；设了才折美元，并把单价打在表头。
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregate, PHASES, fmtMs } from "./lib/cost-aggregate.mjs";

// better-sqlite3 装在 server/ 下（根目录没有）；从那里解析，脚本就能在仓库根直接跑。
const require = createRequire(resolve("server", "package.json"));
const Database = require("better-sqlite3");

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const requestedRun = opt('--run');
if (requestedRun) {
  const projectId = opt('--project'); if (!projectId) throw new Error('--run requires --project for scope validation');
  const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href); register();
  const { runRoleSpend } = await import(pathToFileURL(resolve('server/src/roleSpend.ts')).href);
  console.log(JSON.stringify(runRoleSpend(requestedRun, projectId),null,2)); process.exit(0);
}
const asJson = args.includes("--json");
const project = opt("--project");
const last = Number(opt("--last", "10"));
const dataDir = process.env.TP_DATA_DIR ? resolve(process.env.TP_DATA_DIR) : resolve("server", ".data");
const dbPath = resolve(dataDir, "testpilot.db");
if (!existsSync(dbPath)) {
  console.error(`没有 ${dbPath}——先跑几条用例，或用 TP_DATA_DIR 指向数据目录`);
  process.exit(2);
}
const usdPerMtok = process.env.TP_USD_PER_MTOK ? Number(process.env.TP_USD_PER_MTOK) : undefined;

const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(
    `SELECT id, caseId, caseTitle, priority, status, durationMs, startedAt, tokens, spendJson, oracleJson, infraError, failKind, healed, attempts
       FROM runs ${project ? "WHERE projectId = ?" : ""} ORDER BY startedAt DESC LIMIT 2000`,
  )
  .all(...(project ? [project] : []));

/** 退化账本（T-16）：网关在 PATCH 用例时记的 `degrades.jsonl`。 */
const degrades = (() => {
  const p = resolve(dataDir, "degrades.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
})();
const { cases: table, totals } = aggregate(rows, degrades, { last, usdPerMtok });

if (asJson) {
  console.log(JSON.stringify({ dataDir, project: project ?? null, last, usdPerMtok: usdPerMtok ?? null, cases: table, totals }, null, 2));
  process.exit(0);
}

const pct = (x) => (x === undefined ? "—" : `${Math.round(x * 100)}%`);
const failText = (r) => {
  const parts = Object.entries(r.failures).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  if (r.unobservable) parts.push(`unobservable ${r.unobservable}`);
  return parts.length ? ` (${parts.join(" · ")})` : "";
};
console.log(`# 成本账 · ${project ?? "所有项目"} · 每条用例最近 ${last} 次${usdPerMtok !== undefined ? ` · 单价 $${usdPerMtok}/Mtok` : " · 未设 TP_USD_PER_MTOK，不折美元"}\n`);
console.log("| 用例 | 优先级 | n | 通过率 | 墙钟 中位（散布） | 模型调用 中位 | 模型耗时 中位 | tokens 中位 | 缓存命中率 | 失效 | 机器判定占比 | 自愈 / 退化被拦 |" + (usdPerMtok !== undefined ? " 美元 中位 |" : ""));
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|" + (usdPerMtok !== undefined ? "---|" : ""));
for (const r of table) {
  console.log(
    `| ${r.attribution.window && !r.attribution.runner ? "◌ " : ""}${r.title.slice(0, 40)} | ${r.priority} | ${r.n} | ${pct(r.passRate)}${failText(r)} | ${fmtMs(r.wallMedian)}（${r.wallSpread === "—" ? "—" : `${fmtMs(Number(r.wallSpread.split("–")[0]))}–${fmtMs(Number(r.wallSpread.split("–")[1]))}`}） | ${r.modelCallsMedian ?? "—"} | ${fmtMs(r.modelMsMedian)} | ${r.tokensMedian ?? "—"} | ${pct(r.cacheHitRate)} | ${r.stale} | ${pct(r.oracleMachineShare)} | ${r.healedRuns} / ${r.degraded.blocked}${r.degraded.total > r.degraded.blocked ? `（另 ${r.degraded.total - r.degraded.blocked} 次人改弱）` : ""} |` +
      (usdPerMtok !== undefined ? ` ${r.usdMedian === undefined ? "—" : `$${r.usdMedian.toFixed(3)}`} |` : ""),
  );
}
if (totals.phasedRuns) {
  const label = { launchMs: "起浏览器", loginMs: "登录态", settleMs: "settle", stepsMs: "步骤", assertMs: "判据", teardownMs: "teardown" };
  console.log(`\n墙钟分段（中位，只算有分段记录的运行）：\n\n| 用例 | n | ${PHASES.map((k) => label[k]).join(" | ")} |\n|---|---|${PHASES.map(() => "---").join("|")}|`);
  for (const r of table) if (r.phasedRuns) console.log(`| ${r.title.slice(0, 40)} | ${r.phasedRuns} | ${PHASES.map((k) => fmtMs(r.phaseMedian[k])).join(" | ")} |`);
  const sum = PHASES.reduce((a, k) => a + totals.phases[k], 0);
  console.log(`\n分段合计（${totals.phasedRuns} 次）：${PHASES.map((k) => `${label[k]} ${fmtMs(totals.phases[k])}（${sum ? pct(totals.phases[k] / sum) : "—"}）`).join(" · ")}`);
  console.log("读法：「步骤」以外的五段是不走模型也要付的地板；登录态 + 起浏览器高 → 批次共用浏览器（07 T-28）。");
}
const cacheTotal = totals.hits + totals.misses + totals.stale;
console.log(`
结果：通过 ${totals.passed} · 失败 ${totals.failures.infra + totals.failures.locate + totals.failures.assert + totals.failures.unknown}（infra ${totals.failures.infra} · locate ${totals.failures.locate} · assert ${totals.failures.assert}${totals.failures.unknown ? ` · unknown ${totals.failures.unknown}` : ""}） · unobservable ${totals.unobservable}${(() => { const f = totals.failures.infra + totals.failures.locate + totals.failures.assert + totals.failures.unknown; return f ? ` · 其中 infra 占比 ${pct(totals.failures.infra / f)}` : ""; })()}
合计：${totals.runs} 次运行 · 墙钟 ${fmtMs(totals.wallMs)} · 模型 ${totals.modelCalls} 次 / ${fmtMs(totals.modelMs)}（占墙钟 ${totals.wallMs ? pct(totals.modelMs / totals.wallMs) : "—"}） · ${totals.tokens} tokens${usdPerMtok !== undefined ? ` ≈ $${((totals.tokens / 1e6) * usdPerMtok).toFixed(2)}` : ""}
缓存：命中 ${totals.hits} / 未命中 ${totals.misses} / 失效 ${totals.stale}（命中率 ${cacheTotal ? pct(totals.hits / cacheTotal) : "—"}）
判定：机器 ${totals.machine} / 判官 ${totals.judge}（机器占比 ${totals.machine + totals.judge ? pct(totals.machine / (totals.machine + totals.judge)) : "—"}）

读法：模型耗时占墙钟的比例高 → 降本靠缓存与机器判据；缓存失效高 → 页面在变，不是模型在变；
判官占比 > 0 → 还有用例在让模型看图下判决，它们是最贵、也最不稳的那一批。
自愈：成功 ${totals.healedRuns} 次 · 退化记录 ${totals.degraded.total} 次（被拦 ${totals.degraded.blocked}）——自愈不许改弱判据，改了就回到人。
归账：按 runner 目录 ${totals.attribution.runner} 次（精确） / 按时间窗 ${totals.attribution.window} 次（并发 > 1 会串；行首标 ◌ 的用例全是这种）。`);
