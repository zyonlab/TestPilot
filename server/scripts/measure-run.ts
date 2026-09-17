/**
 * 一跑的归因报表（命令行版）：四节点成绩单 + 成本 + 单元 + 执行 + 归因。
 *
 * 口径全在 `src/runReport.ts`，这里只负责打印；HTTP 上是 `GET …/workflow-runs/:runId/report`，
 * 宿主工具是 `tp_run.report`。三处读的是同一份实现。
 *
 * 用法：pnpm exec tsx scripts/measure-run.ts <runId> <projectId> [--json]
 */
import { runReport, LAYER_LABEL } from "../src/runReport.js";

const [runId, projectId, ...flags] = process.argv.slice(2);
if (!runId || !projectId) {
  console.error("用法：pnpm exec tsx scripts/measure-run.ts <runId> <projectId> [--json]");
  process.exit(2);
}

const report = runReport(runId, projectId);
if (flags.includes("--json")) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

const printBlock = (title: string, metrics: Record<string, unknown>) => {
  console.log(`\n===== ${title} =====`);
  for (const [k, v] of Object.entries(metrics)) {
    if (v === undefined) continue;
    console.log(`  ${k.padEnd(16)} ${typeof v === "object" && v !== null ? JSON.stringify(v) : v}`);
  }
};

console.log(`运行: ${report.runId}  状态: ${report.status}`);
console.log(`节点: ${Object.entries(report.nodes).map(([k, v]) => `${k}=${v}`).join(" ")}`);
for (const [node, metrics] of Object.entries(report.nodes4)) printBlock(node, metrics as Record<string, unknown>);

if (report.units) printBlock("工作单元", { ...report.units.summary, 最多领取次数: report.units.maxAttempt });
if (report.host) {
  const h = report.host;
  printBlock("宿主用量（按 message.id 去重）", {
    轮次: h.turns, 重复行: h.duplicateLines, cache_read: h.cacheReadTokens, cache_write: h.cacheWriteTokens,
    output: h.outputTokens, 单轮缓存读中位: h.cacheReadMedian, 单轮缓存读峰值: h.cacheReadPeak,
    工具报错: h.toolErrors, 自报成本: h.reportedUsd, 正常收尾: h.completed,
  });
}
if (report.execution) {
  const e = report.execution;
  printBlock("最近一次执行", { executionId: e.executionId, 状态: e.status, 用例: e.cases, 按状态: e.byStatus, 按归属: e.byAttribution, 基线对比: e.comparison });
}

console.log("\n===== 归因 =====");
if (!report.signals.length) console.log("  没有触发任何规则");
for (const l of report.layers) console.log(`  ${l.label.padEnd(8)} 分 ${l.score}（问题 ${l.problems} · 观察 ${l.watches}）`);
for (const s of report.signals) {
  const alt = s.alternatives?.length ? `（也可能是：${s.alternatives.map((a) => LAYER_LABEL[a]).join("、")}）` : "";
  console.log(`  [${s.level === "problem" ? "问题" : "观察"}] ${LAYER_LABEL[s.layer]}${alt} · ${s.code}：${s.message}`);
}
