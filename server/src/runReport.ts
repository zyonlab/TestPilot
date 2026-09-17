/**
 * 一跑的归因报表：四个节点的成绩单 + 成本 + 单元 + 门禁 + 执行，合成一页，
 * 再按固定规则把信号归到六层——模型、上下文、工具、工作流、用例、产品。
 *
 * 为什么是「固定规则」而不是让模型去判：归因的价值在于下一步改哪里，
 * 而同一份数据两次给出不同的归因，就没法拿来比较两版之间是不是修好了。
 * 每条信号都带着触发它的数和出处，人一眼能看出它凭什么这么说；规则错了改规则。
 *
 * 只组装、不重算：分数与机检一律取服务端已有的实现（`checkModulePlan` /
 * `checkStories` / `runGate` 的落盘结果 / `runRoleSpend` / 执行产物 / 基线对比）。
 * `server/scripts/measure-run.ts` 调的也是这里，两处不会有两套口径。
 *
 * 2026-09-16 的教训写在这里：**一个节点一个数会骗人**。「动作型准则占比」
 * 在两跑模块树不同时根本不可比；宿主流水按行累加 usage 会重复计数。
 * 所以报表把结构节点摆在最前面，宿主用量按 `message.id` 去重。
 */
import { existsSync, readFileSync } from "node:fs";
import { checkModulePlan } from "@testpilot/harness-testing/domain";
import { runLedger } from "./runService.js";
import { acceptanceIndex, checkStories } from "./acceptanceIndex.js";
import { runScopeMaterials } from "./runStages.js";
import { unitStatus } from "./workUnits.js";
import { runRoleSpend } from "./roleSpend.js";
import { listWorkflowExecutions } from "./workflowExecution.js";
import { compareToBaseline } from "./executionBaseline.js";
import { dataPath } from "./datadir.js";

export type Layer = "model" | "context" | "tool" | "workflow" | "case" | "product";
export const LAYER_LABEL: Record<Layer, string> = {
  model: "模型", context: "上下文", tool: "工具与环境", workflow: "工作流", case: "用例", product: "产品",
};

export interface Signal {
  /** 最可能的那一层。 */
  layer: Layer;
  /** 同样说得通、但数据分不开的其他层。 */
  alternatives?: Layer[];
  level: "problem" | "watch";
  code: string;
  message: string;
  evidence: Record<string, unknown>;
}

type Any = any; // 账本内容是各节点自己的 schema，这里只读几个字段。

function reader(runId: string, projectId: string) {
  const ledger = runLedger();
  const revisions = ledger.listRevisions(projectId, runId);
  const pick = (match: (name: string) => boolean): Any => {
    const rev = revisions.filter((r) => match(r.name)).sort((a, b) => a.revision - b.revision).at(-1);
    return rev ? ledger.readRevision(rev.id, projectId).content : undefined;
  };
  return { latest: (name: string) => pick((n) => n === name), pick, ledger };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2]! : Math.round((a[a.length / 2 - 1]! + a[a.length / 2]!) / 2);
};
const tally = <T>(xs: T[], key: (x: T) => string): Record<string, number> =>
  xs.reduce((m: Record<string, number>, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});
const pct = (n: number, d: number) => (d ? +((n / d) * 100).toFixed(1) : 0);

/** 产品结构：模块树的形状，以及产品模型里的功能有没有被认领干净。 */
export function productStructure(runId: string, projectId: string) {
  const { latest } = reader(runId, projectId);
  const plan = latest("validated/modules") ?? latest("product/module-plan") ?? latest("product/module-plan-candidate");
  const model = latest("product/model-candidate");
  if (!plan) return { 有产物: false as const };
  const modules: Any[] = plan.modules ?? [];
  const leaves = modules.filter((m) => !modules.some((x) => x.parentId === m.id));
  const depthOf = (m: Any): number => (m?.parentId ? 1 + depthOf(modules.find((x) => x.id === m.parentId)) : 1);
  const features: Any[] = model?.features ?? [];
  const claimed = new Set(modules.flatMap((m) => m.featureIds ?? []));
  let findings: Any[] = [];
  try {
    // 与定稿时同一个调用（runStages.ts 的 finalize）：带上故事，叶子扇出才算得出来。
    const stories: Any[] = latest("validated/stories")?.stories ?? [];
    findings = checkModulePlan({
      modules: plan.modules ?? [],
      outOfScope: plan.outOfScope ?? [],
      stories: stories.map((st) => ({ id: st.id, moduleIds: st.moduleIds ?? [] })),
    }) as Any[];
  } catch (e) {
    findings = [{ code: "check_failed", severity: "error", message: String((e as Error)?.message).slice(0, 120) }];
  }
  return {
    有产物: true as const,
    模块: modules.length,
    根: modules.filter((m) => !m.parentId).length,
    叶子: leaves.length,
    最大深度: modules.length ? Math.max(...modules.map(depthOf)) : 0,
    功能: features.length,
    被认领: claimed.size,
    未认领: features.filter((f) => !claimed.has(f.id)).length,
    outOfScope: modules.filter((m) => m.outOfScope).length,
    无理由的outOfScope: modules.filter((m) => m.outOfScope && !m.outOfScopeReason).length,
    角色: (model?.roles ?? []).length,
    规则绑定: (model?.ruleBindings ?? []).length,
    规则绑定状态: tally(model?.ruleBindings ?? [], (b: Any) => b.status ?? "?"),
    机检发现: findings.length,
    机检按码: tally(findings, (f: Any) => `${f.code}/${f.severity ?? "-"}`),
  };
}

/** 用户故事：故事够不够、准则要不要用户动手、有没有出处、每个叶子都长出东西了没有。 */
export function userStories(runId: string, projectId: string) {
  const { latest } = reader(runId, projectId);
  const bundle = latest("validated/stories");
  if (!bundle) return { 有产物: false as const };
  const plan = latest("validated/modules") ?? latest("product/module-plan");
  const stories: Any[] = bundle.stories ?? [];
  const vocabulary: string[] = (runScopeMaterials(runId, projectId) as Any).actionVocabulary ?? [];
  const criteria: string[] = stories.flatMap((s) => s.acceptance ?? []);
  const entries = acceptanceIndex(stories as never, vocabulary);
  const findings = checkStories(stories as never, vocabulary);
  const modules: Any[] = plan?.modules ?? [];
  const leaves = modules.filter((m) => !modules.some((x) => x.parentId === m.id)).map((m) => m.id);
  const perLeaf = new Map(leaves.map((id) => [id, 0]));
  for (const s of stories) for (const mid of s.moduleIds ?? []) if (perLeaf.has(mid)) perLeaf.set(mid, perLeaf.get(mid)! + 1);
  const fanout = [...perLeaf.values()];
  const actionable = entries.filter((e) => e.actionable).length;
  return {
    有产物: true as const,
    故事: stories.length,
    验收准则: criteria.length,
    每故事准则: +(criteria.length / Math.max(1, stories.length)).toFixed(2),
    // 词表是这把尺子的一部分：判定「要用户动手」先看通用动作动词，再看本项目的行业词表。
    词表: vocabulary.length,
    动作型: actionable,
    动作型占比: pct(actionable, entries.length),
    叶子: leaves.length,
    叶子扇出均值: +(fanout.reduce((a, b) => a + b, 0) / Math.max(1, leaves.length)).toFixed(2),
    空叶子: fanout.filter((n) => n === 0).length,
    待确认: criteria.filter((c) => /待确认/.test(c)).length,
    出处覆盖率: pct(criteria.filter((c) => /依据\s*\S+#\d+/.test(c)).length, criteria.length),
    角色: new Set(stories.map((s) => s.role).filter(Boolean)).size,
    机检发现: findings.length,
    机检按码: tally(findings, (f) => f.code),
  };
}

/** 文本用例：门禁自己的分与它点到的问题，外加 tier、负例比、孤儿与重复。 */
export function textCases(runId: string, projectId: string) {
  const { latest } = reader(runId, projectId);
  const gate = latest("validated/gate");
  const bundle = latest("validated/cases");
  if (!gate && !bundle) return { 有产物: false as const };
  const report = gate?.report ?? gate;
  const cases: Any[] = bundle?.cases ?? [];
  const stats = report?.stats ?? {};
  const findings: Any[] = report?.findings ?? [];
  return {
    有产物: true as const,
    用例: cases.length || stats.cases || 0,
    门禁分: report?.score !== undefined ? +report.score.toFixed(4) : undefined,
    过没过: gate?.passed as boolean | undefined,
    被扣分的用例: (report?.scoreBasis?.flagged ?? []).length as number,
    tier分布: (stats.tiers ?? tally(cases, (c: Any) => String(c.tier ?? "?"))) as Record<string, number>,
    负例比: stats.negativeRatio as number | undefined,
    负例比阈值: stats.minNegativeRatio as number | undefined,
    方法分布: stats.methods,
    孤儿: stats.orphans,
    重复: stats.duplicates,
    步数中位: median(cases.map((c) => (c.steps ?? []).length)),
    步数最大: cases.length ? Math.max(...cases.map((c) => (c.steps ?? []).length)) : 0,
    机检发现: findings.length,
    机检按码: tally(findings, (f: Any) => `${f.rule}/${f.severity}`),
  };
}

/** 用例代码：g2 编出来的东西——多少条用例有代码、自愈修了几轮、最后跑成什么样。 */
export function caseCode(runId: string, projectId: string) {
  const { pick } = reader(runId, projectId);
  const bundle = pick((n) => n.startsWith("g2/"));
  if (!bundle) return { 有产物: false as const, 说明: "这一跑没有 g2 产物（未走到批准后编译）" };
  const code: Any[] = bundle.code ?? [];
  const repair = bundle.repair ?? {};
  return {
    有产物: true as const,
    有代码的用例: code.length,
    // 编译不出来的用例：它们批准了却进不了执行，是这个节点最该看的一个数。
    编译失败: (bundle.failed ?? []).length as number,
    代码行数中位: median(code.map((c) => (c.code ?? "").split("\n").length)),
    代码行数最大: code.length ? Math.max(...code.map((c) => (c.code ?? "").split("\n").length)) : 0,
    动作数中位: median(code.map((c) => (c.actions ?? []).length)),
    用到的片段: new Set(code.flatMap((c) => c.uses ?? [])).size,
    自愈轮次: (repair.rounds ?? []).length,
    被降级的用例: (repair.degraded ?? []).length,
    宽松通过率: repair.loosePassRate,
    严格通过率: repair.strictPassRate,
    入口策略: bundle.entryPolicy,
    编译方式: bundle.compilation,
  };
}

export interface HostUsage {
  turns: number;
  duplicateLines: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cacheReadMedian: number;
  cacheReadPeak: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  reportedUsd: number | null;
  completed: boolean;
}

/**
 * 宿主（Claude Code）的逐轮用量，从 `claude-stream.jsonl` 读。
 *
 * **按 `message.id` 去重**：同一条 assistant 消息会拆成 thinking / text / tool_use 多行，
 * 每行都带同一份 usage。2026-09-16 按行累加，两跑拆行比例不同（26 vs 82 行重复），
 * 算出「变贵了」的假结论。这里取每条消息最后一次出现的 usage。
 */
export function parseHostStream(text: string): HostUsage {
  const byId = new Map<string, Any>();
  let duplicateLines = 0, anonymous = 0, toolErrors = 0, reportedUsd: number | null = null, completed = false;
  const toolCalls: Record<string, number> = {};
  const toolUseIds = new Set<string>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: Any;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line.type === "result") {
      completed = true;
      if (typeof line.total_cost_usd === "number") reportedUsd = (reportedUsd ?? 0) + line.total_cost_usd;
      continue;
    }
    const content = line.message?.content;
    if (line.type === "assistant" && line.message?.usage) {
      const id = line.message.id ?? `anonymous-${anonymous++}`;
      if (byId.has(id)) duplicateLines++;
      byId.set(id, line.message.usage);
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && !toolUseIds.has(block.id)) {
        toolUseIds.add(block.id);
        const name = String(block.name ?? "").replace(/^mcp__[^_]+__/, "");
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      }
      if (block.type === "tool_result" && block.is_error) toolErrors++;
    }
  }
  const usages = [...byId.values()];
  const sum = (k: string) => usages.reduce((a, u) => a + (Number(u[k]) || 0), 0);
  const cacheReads = usages.map((u) => Number(u.cache_read_input_tokens) || 0);
  return {
    turns: usages.length,
    duplicateLines,
    inputTokens: sum("input_tokens"),
    cacheReadTokens: sum("cache_read_input_tokens"),
    cacheWriteTokens: sum("cache_creation_input_tokens"),
    outputTokens: sum("output_tokens"),
    cacheReadMedian: median(cacheReads),
    cacheReadPeak: cacheReads.length ? Math.max(...cacheReads) : 0,
    toolCalls,
    toolErrors,
    reportedUsd,
    completed,
  };
}

/** Web 发起的 Claude Code 运行才有这份流水；宿主自己起的运行没有，返回 null。 */
export function hostUsage(runId: string): HostUsage | null {
  const path = dataPath(`host-workspaces/${runId}/runs/${runId}/claude-stream.jsonl`);
  return existsSync(path) ? parseHostStream(readFileSync(path, "utf8")) : null;
}

/** 最近一次执行的逐条结果，按状态与失败归属汇总；有基线时附上翻转对比。 */
export function latestExecution(runId: string, projectId: string) {
  const executions = listWorkflowExecutions(runId, projectId) as Any[];
  const last = executions[0];
  if (!last) return null;
  const artifact: Any = last.resultRevision ? runLedger().readRevision(last.resultRevision, projectId).content : undefined;
  const results: Any[] = (artifact?.results ?? []).filter((r: Any) => r?.caseId);
  const failing = results.filter((r) => r.status !== "passed");
  // 与 regressionCandidates 同一口径：带着环境错误标记的，不管 failure.code 写的是什么，都不算判决。
  const attributionOf = (r: Any): string => r.infraError ? "infra" : r.failure?.attribution ?? (r.status === "unobservable" ? "unobservable" : "unknown");
  // 判挂这条的是程序还是模型：失败的判据里只要有一条是程序判的，就算程序。
  const decidedBy = (r: Any): "machine" | "judge" | null => {
    const failed = (r.oracle ?? []).filter((o: Any) => o.status === "fail");
    if (!failed.length) return null;
    return failed.some((o: Any) => o.decidedBy !== "judge") ? "machine" : "judge";
  };
  let comparison: Any = null;
  try {
    const c: Any = compareToBaseline(runId, projectId, { executionId: last.id });
    comparison = { summary: c.summary, byCase: Object.fromEntries((c.cases ?? []).map((x: Any) => [x.caseId, x.change])) };
  } catch {
    comparison = null; // 没立基线：分不开「一直是坏的」和「刚坏的」。
  }
  return {
    executionId: last.id as string,
    status: last.status as string,
    cases: results.length,
    byStatus: tally(results, (r) => r.status),
    byAttribution: tally(failing, attributionOf),
    byCode: tally(failing, (r) => r.failure?.code ?? r.status),
    failing: failing.map((r) => ({
      caseId: r.caseId as string,
      status: r.status as string,
      code: (r.failure?.code ?? null) as string | null,
      attribution: attributionOf(r) as string | null,
      decidedBy: decidedBy(r),
      change: (comparison?.byCase?.[r.caseId] ?? null) as string | null,
      reason: String(r.failureReason ?? r.unobservableReason ?? "").slice(0, 160),
    })),
    comparison: comparison?.summary ?? null,
  };
}

/** 固定阈值：改它就是改报表的口径，要在交接记录里写明。 */
export const REPORT_THRESHOLDS = {
  /** 零动作型准则的故事占比超过它才提示（展示型故事是合法的，少量不算问题）。 */
  storiesWithoutActionShare: 0.1,
  citationCoverage: 80,
  /** 单轮缓存读逼近 1M 上下文：再往上就是塞满了。 */
  cacheReadPeak: 700_000,
  unitAttempts: 2,
} as const;

export function attribute(parts: {
  structure: ReturnType<typeof productStructure>;
  stories: ReturnType<typeof userStories>;
  cases: ReturnType<typeof textCases>;
  code: ReturnType<typeof caseCode>;
  units: ReturnType<typeof unitStatus> | null;
  host: HostUsage | null;
  plannerCoverage: string | null;
  execution: ReturnType<typeof latestExecution>;
}): Signal[] {
  const out: Signal[] = [];
  const add = (s: Signal) => out.push(s);
  const { structure: st, stories: sy, cases: cs, code, units, host, execution: ex } = parts;

  if (st.有产物) {
    if (st.未认领 > 0)
      add({ layer: "context", level: "problem", code: "features_unclaimed", message: `${st.未认领} 个功能没有被任何叶子模块认领，它们的规则流不到故事节点`, evidence: { 未认领: st.未认领, 功能: st.功能 } });
    if (st.无理由的outOfScope > 0)
      add({ layer: "workflow", level: "watch", code: "out_of_scope_without_reason", message: "有模块被划出范围却没写理由", evidence: { 数量: st.无理由的outOfScope } });
    if (st.机检发现 > 0)
      add({ layer: "model", alternatives: ["context"], level: "watch", code: "module_plan_findings", message: "模块树提案有机检发现：模型没按契约拆，或契约没把要求交出去", evidence: st.机检按码 });
  }

  if (sy.有产物) {
    if (sy.空叶子 > 0)
      add({ layer: "workflow", level: "problem", code: "empty_leaves", message: `${sy.空叶子} 个叶子模块一条故事都没长出来`, evidence: { 空叶子: sy.空叶子, 叶子: sy.叶子 } });
    const noAction = (sy.机检按码 as Record<string, number>).story_has_no_actionable_criterion ?? 0;
    if (sy.故事 && noAction / sy.故事 > REPORT_THRESHOLDS.storiesWithoutActionShare)
      add({ layer: "context", alternatives: ["model"], level: "watch", code: "stories_without_action",
        message: `${noAction}/${sy.故事} 条故事没有要用户动手的准则。先看单元材料里有没有行业动作词表；展示型故事本身是合法的`,
        evidence: { 零动作型故事: noAction, 故事: sy.故事, 动作型占比: sy.动作型占比, 词表: sy.词表 } });
    if (sy.验收准则 && sy.出处覆盖率 < REPORT_THRESHOLDS.citationCoverage)
      add({ layer: "context", level: "watch", code: "low_citation_coverage", message: `只有 ${sy.出处覆盖率}% 的准则写了出处`, evidence: { 出处覆盖率: sy.出处覆盖率 } });
    if (sy.词表 === 0)
      add({ layer: "context", level: "watch", code: "no_action_vocabulary", message: "这一跑绑定的规则包没有行业动作词表，「动作型」只能靠通用动词判断", evidence: {} });
  }

  if (cs.有产物) {
    if (cs.过没过 === false)
      add({ layer: "workflow", level: "problem", code: "gate_failed", message: `设计门禁没过（${cs.门禁分}）`, evidence: { 门禁分: cs.门禁分, 被扣分的用例: cs.被扣分的用例 } });
    const byRule = cs.机检按码 as Record<string, number>;
    const oracleWarns = Object.entries(byRule).filter(([k]) => /^oracle-.*\/warn$/.test(k));
    if (oracleWarns.length)
      add({ layer: "case", level: "watch", code: "oracle_warnings", message: "有用例的判据被门禁警告（模糊、易变或不在屏幕上）", evidence: Object.fromEntries(oracleWarns) });
    if (byRule["case-without-action/warn"])
      add({ layer: "case", level: "watch", code: "cases_without_action", message: `${byRule["case-without-action/warn"]} 条用例没有动作，通过时什么都没证明`, evidence: { 数量: byRule["case-without-action/warn"] } });
    if (byRule["acceptance-uncovered/warn"])
      add({ layer: "case", alternatives: ["workflow"], level: "watch", code: "acceptance_uncovered", message: "有要动手的验收准则没被任何真做了动作的用例覆盖", evidence: { 数量: byRule["acceptance-uncovered/warn"] } });
    if (cs.负例比 !== undefined && cs.负例比阈值 !== undefined && cs.负例比 < cs.负例比阈值)
      add({ layer: "case", level: "watch", code: "few_negative_cases", message: `负例比 ${cs.负例比} 低于阈值 ${cs.负例比阈值}`, evidence: { 负例比: cs.负例比, 阈值: cs.负例比阈值 } });
  }

  if (code.有产物 && code.编译失败 > 0)
    add({ layer: "case", alternatives: ["tool"], level: "problem", code: "compile_failed", message: `${code.编译失败} 条批准过的用例编译不出代码，进不了执行`, evidence: { 编译失败: code.编译失败 } });

  if (units?.enabled) {
    if (units.summary.failed > 0)
      add({ layer: "workflow", level: "problem", code: "units_failed", message: `${units.summary.failed} 个工作单元停在失败`, evidence: { failed: units.units.filter((u) => u.status === "failed").map((u) => ({ unitId: u.unitId, reason: u.reason })) } });
    const retried = units.units.filter((u) => u.attempt > REPORT_THRESHOLDS.unitAttempts);
    if (retried.length)
      // 反复被拒最常见的原因是契约没把门禁要的事实交出去，模型只能猜（见 testpilot-hand-over-the-number）。
      add({ layer: "context", alternatives: ["model"], level: "watch", code: "units_retried", message: `${retried.length} 个单元领了 ${REPORT_THRESHOLDS.unitAttempts} 次以上才写进去：先查契约是不是没交出校验要的数`, evidence: { units: retried.map((u) => ({ unitId: u.unitId, attempt: u.attempt })) } });
    const repaired = units.units.filter((u) => u.repair);
    if (repaired.length)
      add({ layer: "workflow", level: "watch", code: "units_reopened_by_gate", message: `门禁把 ${repaired.length} 个单元打回重写`, evidence: { units: repaired.map((u) => ({ unitId: u.unitId, round: u.repair?.round })) } });
  }

  if (parts.plannerCoverage === "unknown")
    add({ layer: "tool", level: "watch", code: "planner_spend_unknown", message: "规划侧用量没记上（宿主进程可能没正常收尾）", evidence: { coverage: parts.plannerCoverage } });
  if (host) {
    if (!host.completed)
      add({ layer: "tool", level: "watch", code: "host_not_completed", message: "宿主流水里没有收尾的 result 行", evidence: { turns: host.turns } });
    if (host.cacheReadPeak > REPORT_THRESHOLDS.cacheReadPeak)
      add({ layer: "context", level: "watch", code: "context_near_full", message: `单轮缓存读峰值 ${host.cacheReadPeak.toLocaleString()} token，上下文接近塞满，每一轮都按这个量计费`, evidence: { cacheReadPeak: host.cacheReadPeak, cacheReadMedian: host.cacheReadMedian } });
    if (host.toolErrors > 0)
      add({ layer: "tool", alternatives: ["context"], level: "watch", code: "host_tool_errors", message: `宿主有 ${host.toolErrors} 次工具调用报错或被拒`, evidence: { toolErrors: host.toolErrors } });
  }

  if (ex) {
    const infra = ex.failing.filter((f) => f.attribution === "infra");
    if (infra.length)
      add({ layer: "tool", alternatives: infra.some((f) => f.code === "MODEL_UNAVAILABLE") ? ["model"] : undefined, level: "problem", code: "exec_infra",
        message: `${infra.length} 条用例因环境、端点或超时没跑成，不算判决`, evidence: { byCode: tally(infra, (f) => f.code ?? "?") } });
    const locate = ex.failing.filter((f) => f.attribution === "locate");
    if (locate.length)
      // 定位/规划失败：多数是步骤措辞不可执行，少数是视觉模型没认出来；数据分不开，两层都列。
      add({ layer: "case", alternatives: ["model"], level: "problem", code: "exec_locate",
        message: `${locate.length} 条用例的步骤没能落到界面上（定位或拆动作失败）：先改措辞，再怀疑视觉模型`, evidence: { cases: locate.map((f) => f.caseId) } });
    const asserts = ex.failing.filter((f) => f.attribution === "assert");
    const regressed = asserts.filter((f) => f.change === "regressed");
    const flaky = ex.failing.filter((f) => f.change === "flaky");
    const unknownHistory = asserts.filter((f) => f.change !== "regressed" && f.change !== "flaky");
    /**
     * 模型判挂的，先怀疑判官与用例，不先怀疑产品。
     *
     * 2026-09-16 测试网真跑：4 条判定失败里 3 条是 tier 3 判官判的，逐条看证据全不是产品问题——
     * 判官看错了区域、选错了行；剩下 1 条程序判据读到的是同一标签旁边的另一个数。
     * 当时这条规则把 4 条都归到「产品」，一条都没说对。
     */
    const judged = unknownHistory.filter((f) => f.decidedBy === "judge");
    const machineJudged = unknownHistory.filter((f) => f.decidedBy !== "judge");
    if (judged.length)
      add({ layer: "model", alternatives: ["case", "product"], level: "watch", code: "exec_assert_by_judge",
        message: `${judged.length} 条用例是模型判官判挂的：先核对判官读的是不是那一处、用例措辞对判官是否明确，再怀疑产品`,
        evidence: { cases: judged.map((f) => f.caseId) } });
    if (regressed.length)
      add({ layer: "product", level: "problem", code: "exec_regressed", message: `${regressed.length} 条用例在基线里是过的、这次判定失败：最可能是产品变了`, evidence: { cases: regressed.map((f) => f.caseId) } });
    if (flaky.length)
      add({ layer: "model", alternatives: ["tool"], level: "watch", code: "exec_flaky", message: `${flaky.length} 条用例的判决来回翻：判官或定位不稳`, evidence: { cases: flaky.map((f) => f.caseId) } });
    if (machineJudged.length)
      add({ layer: "product", alternatives: ["case"], level: "problem", code: ex.comparison ? "exec_assert_still_failing" : "exec_assert_no_baseline",
        message: ex.comparison
          ? `${machineJudged.length} 条用例被程序判据判失败且一直失败：要么产品本来就坏，要么判据读错了地方——看失败原因逐条定`
          : `${machineJudged.length} 条用例被程序判据判失败，但没有执行基线，分不开「刚坏的」和「一直坏的」`,
        evidence: { cases: machineJudged.map((f) => f.caseId) } });
    if ((ex.byStatus.unobservable ?? 0) > 0)
      add({ layer: "case", alternatives: ["tool"], level: "watch", code: "exec_unobservable", message: `${ex.byStatus.unobservable} 条用例的判据没量到`, evidence: {} });
  }
  return out;
}

/** 把信号按层汇总：问题记 2 分、观察记 1 分；并列时按固定顺序。 */
export function rankLayers(signals: Signal[]) {
  const order: Layer[] = ["product", "case", "workflow", "context", "model", "tool"];
  const score = new Map<Layer, { score: number; problems: number; watches: number }>();
  for (const s of signals) {
    const cur = score.get(s.layer) ?? { score: 0, problems: 0, watches: 0 };
    score.set(s.layer, { score: cur.score + (s.level === "problem" ? 2 : 1), problems: cur.problems + (s.level === "problem" ? 1 : 0), watches: cur.watches + (s.level === "watch" ? 1 : 0) });
  }
  return [...score.entries()]
    .sort((a, b) => b[1].score - a[1].score || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([layer, v]) => ({ layer, label: LAYER_LABEL[layer], ...v }));
}

export function runReport(runId: string, projectId: string) {
  const run = runLedger().getRun(runId, projectId) as Any;
  const structure = productStructure(runId, projectId);
  const stories = userStories(runId, projectId);
  const cases = textCases(runId, projectId);
  const code = caseCode(runId, projectId);
  let units: ReturnType<typeof unitStatus> | null = null;
  try { units = unitStatus(runId, projectId); } catch { units = null; }
  const spend = runRoleSpend(runId, projectId) as Any;
  const host = hostUsage(runId);
  const execution = latestExecution(runId, projectId);
  const plannerCoverage = (spend.roles ?? []).find((r: Any) => r.role === "planner")?.coverage ?? null;
  const signals = attribute({ structure, stories, cases, code, units, host, plannerCoverage, execution });
  return {
    runId,
    projectId,
    status: run.status as string,
    nodes: Object.fromEntries((run.nodes ?? []).map((n: Any) => [n.node, n.phase])),
    nodes4: { 产品结构: structure, 用户故事: stories, 文本用例: cases, 用例代码: code },
    units: units ? { enabled: units.enabled, summary: units.summary, maxAttempt: Math.max(0, ...units.units.map((u) => u.attempt)) } : null,
    spend: { roles: spend.roles, wallMs: spend.wallMs, priceNote: spend.priceNote },
    host,
    execution,
    layers: rankLayers(signals),
    signals,
    thresholds: REPORT_THRESHOLDS,
  };
}
