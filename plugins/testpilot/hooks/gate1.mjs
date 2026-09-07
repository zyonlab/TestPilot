#!/usr/bin/env node
/**
 * 门禁①，作为 hook。
 *
 * **规则不在这里**——这里 `import` 的是 `packages/harness-testing/src/casegen/gate.ts`，
 * 和 A 臂 `run_pipeline` 跑的是同一个 `runGate`。抄一份到 hook 里，两臂就不再只差一件事，
 * 而 Phase 3 的配对评测正是建立在"只差一件事"上的。
 *
 * 挂点：`pre_tool_use` 拦住写 `runs/<id>/meta.json` 那一次调用。为什么是 meta.json 而不是
 * cases.json——门禁要读**已经落盘的**用例，而 pre_tool_use 拿到的是"将要写的内容"。
 * `meta.json` 在 testpilot-run-c 的顺序里是最后一步，写它的时候 cases.json 已经在盘上了。
 * 于是这一拦同时实现了 `stopAfter` 的语义：**分数不到线就写不出 meta.json，
 * 这次运行就没有来源印记，`score_run` 也就不会给它打分**（数据契约 §1：缺 RunMeta 拒绝打分）。
 *
 * 副作用是刻意的：不管过不过，都把 `GateReport` 写成 `runs/<id>/gate.json`。
 * hook 是普通 Node 子进程，写盘完全正当（契约 §4）。
 *
 * 一处退化，写在这里也写在契约 §3：**门禁过了的时候，`allow` 的 reason 模型看不见。**
 * 只有 `deny` 的 reason 进模型上下文。所以过的时候数字只进 trace 和 gate.json，
 * 要靠 SKILL 正文让模型自己去读 gate.json。
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { input, answer, abstain, loadRepo, writeFileArgs, config, zodBrief, recordHold } from "./lib/tp.mjs";

try {
  const msg = await input();
  const args = writeFileArgs(msg);
  if (!args) abstain();
  if (!/[/\\]runs[/\\][^/\\]+[/\\]meta\.json$/.test(args.file_path)) abstain();

  const cfg = config();
  const runDir = path.dirname(args.file_path);
  const runId = path.basename(runDir);
  const casesPath = path.join(runDir, "cases.json");

  if (!existsSync(casesPath)) {
    recordHold(runDir, { hook: "gate1", gate: "gate1", kind: "no-cases", runId });
    answer({
      decision: "deny",
      reason:
        `${runId}/cases.json 还不存在，门禁没有可判的东西。顺序是写死的：stories → cases → 等门禁放行 → meta。` +
        `先把 cases.json 写出来。`,
      output: { gate: "no-cases", runId },
    });
    process.exit(0);
  }

  const { types, gate } = await loadRepo();
  const raw = JSON.parse(readFileSync(casesPath, "utf8"));
  const parsed = types.CaseBundleSchema.safeParse(raw);
  if (!parsed.success) {
    recordHold(runDir, { hook: "gate1", gate: "schema", kind: "bad-cases", runId });
    answer({
      decision: "deny",
      reason: `${runId}/cases.json 落盘之后仍不符合 CaseBundleSchema：${zodBrief(parsed.error)}`,
      output: { gate: "bad-cases", runId },
    });
    process.exit(0);
  }

  const report = gate.runGate(parsed.data, { minNegativeRatio: cfg.minNegativeRatio });
  writeFileSync(path.join(runDir, "gate.json"), JSON.stringify(report, null, 2) + "\n");

  const warns = report.findings.filter((f) => f.severity === "warn");
  const s = report.stats;
  // 把话说到能改的地步：哪几条规则、各几条、比例对哪条线。
  const byRule = {};
  for (const f of warns) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  const ruleLine =
    Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}×${n}`)
      .join("、") || "无";

  const facts =
    `门禁① score=${report.score.toFixed(3)}（阈值 ${cfg.minGateScore}）· ` +
    `用例 ${s.cases} 条，其中 ${report.scoreBasis?.flagged?.length ?? 0} 条被 warn 点到 · ` +
    `negativeRatio=${s.negativeRatio}（下限 ${s.minNegativeRatio}）· ` +
    `warn 分布：${ruleLine} · 全文见 ${runId}/gate.json`;

  if (report.score < cfg.minGateScore) {
    recordHold(runDir, {
      hook: "gate1",
      gate: "gate1",
      kind: "below-threshold",
      runId,
      score: Number(report.score.toFixed(3)),
      threshold: cfg.minGateScore,
      warns: warns.length,
    });
    // 举三条具体的，模型才知道该改哪里；只给数字它只会重写一遍风格。
    const examples = warns
      .slice(0, 3)
      .map((f) => `[${f.rule}]${f.caseId ? ` ${f.caseId}` : ""} ${f.message}`)
      .join(" / ");
    answer({
      decision: "deny",
      reason:
        `${facts}。分数低于阈值，这次运行不放行。修 cases.json 里被点到的那几条再写 meta.json。` +
        `例如：${examples}`,
      output: {
        gate: "below-threshold",
        runId,
        score: Number(report.score.toFixed(3)),
        threshold: cfg.minGateScore,
        cases: s.cases,
        warns: warns.length,
        negativeRatio: s.negativeRatio,
      },
    });
    process.exit(0);
  }

  answer({
    reason: facts,
    output: {
      gate: "pass",
      runId,
      score: Number(report.score.toFixed(3)),
      threshold: cfg.minGateScore,
      cases: s.cases,
      warns: warns.length,
      negativeRatio: s.negativeRatio,
    },
  });
} catch (err) {
  process.stderr.write(`gate1 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
