/**
 * 一跑的四节点成绩单：产品结构 · 用户故事 · 文本用例 · 用例代码。
 *
 * 为什么要有这个脚本：2026-09-16 量 `claim_unit` 瘦身效果时，我拿临时脚本只量了故事节点，
 * 用「动作型准则占比」一个数就差点判优化失败——而那个数在两跑模块树不同时根本不可比。
 * 后来把四个节点一起摆出来才看清：结构节点两跑完全一致（同一份导入的产品模型），
 * 所以故事节点的差异确实是故事写法变了，不是抽到的模块不同。
 *
 * **一个节点一个数会骗人，四个节点一起看才判得准。** 指标全部取自服务端已有的机检，
 * 不另立一套标准：`checkModulePlan` / `checkStories` / `runGate` 说了算。
 *
 * 用法：pnpm exec tsx scripts/measure-run.ts <runId> <projectId> [--json]
 */
import { runLedger } from "../src/runService.js";
import { acceptanceIndex, checkStories } from "../src/acceptanceIndex.js";
import { runScopeMaterials } from "../src/runStages.js";
import { checkModulePlan } from "@testpilot/harness-testing/domain";

const [runId, projectId, ...flags] = process.argv.slice(2);
if (!runId || !projectId) {
  console.error("用法：pnpm exec tsx scripts/measure-run.ts <runId> <projectId> [--json]");
  process.exit(2);
}
const asJson = flags.includes("--json");

const ledger = runLedger();
const latest = (name: string): any => {
  const rev = ledger
    .listRevisions(projectId, runId)
    .filter((r: any) => r.name === name)
    .sort((a: any, b: any) => a.revision - b.revision)
    .at(-1);
  return rev ? ledger.readRevision(rev.id, projectId).content : undefined;
};
const byName = (predicate: (name: string) => boolean): any => {
  const rev = ledger
    .listRevisions(projectId, runId)
    .filter((r: any) => predicate(r.name))
    .sort((a: any, b: any) => a.revision - b.revision)
    .at(-1);
  return rev ? ledger.readRevision(rev.id, projectId).content : undefined;
};
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2]! : Math.round((a[a.length / 2 - 1]! + a[a.length / 2]!) / 2);
};
const tally = <T>(xs: T[], key: (x: T) => string): Record<string, number> =>
  xs.reduce((m: Record<string, number>, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});
const pct = (n: number, d: number) => (d ? +((n / d) * 100).toFixed(1) : 0);

/** 产品结构：模块树的形状，以及产品模型里的功能有没有被认领干净。 */
function productStructure() {
  const plan = latest("validated/modules") ?? latest("product/module-plan") ?? latest("product/module-plan-candidate");
  const model = latest("product/model-candidate");
  if (!plan) return { 有产物: false };
  const modules: any[] = plan.modules ?? [];
  const leaves = modules.filter((m) => !modules.some((x) => x.parentId === m.id));
  const depthOf = (m: any): number => (m?.parentId ? 1 + depthOf(modules.find((x) => x.id === m.parentId)) : 1);
  const features: any[] = model?.features ?? [];
  const claimed = new Set(modules.flatMap((m) => m.featureIds ?? []));
  let planFindings: any[] = [];
  try {
    planFindings = checkModulePlan(plan as never, model as never) as any[];
  } catch (e: any) {
    planFindings = [{ code: "checkModulePlan 调不通", message: String(e?.message).slice(0, 120) }];
  }
  return {
    有产物: true,
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
    规则绑定状态: tally(model?.ruleBindings ?? [], (b: any) => b.status ?? "?"),
    机检发现: planFindings.length,
    机检按码: tally(planFindings, (f: any) => `${f.code}/${f.severity ?? "-"}`),
  };
}

/** 用户故事：故事够不够、准则要不要用户动手、有没有出处、每个叶子都长出东西了没有。 */
function userStories() {
  const bundle = latest("validated/stories");
  if (!bundle) return { 有产物: false };
  const plan = latest("validated/modules") ?? latest("product/module-plan");
  const stories: any[] = bundle.stories ?? [];
  const vocabulary: string[] = (runScopeMaterials(runId, projectId) as any).actionVocabulary ?? [];
  const criteria: string[] = stories.flatMap((s) => s.acceptance ?? []);
  const entries = acceptanceIndex(stories as never, vocabulary);
  const findings = checkStories(stories as never, vocabulary);
  const modules: any[] = plan?.modules ?? [];
  const leaves = modules.filter((m) => !modules.some((x) => x.parentId === m.id)).map((m) => m.id);
  const perLeaf = new Map(leaves.map((id) => [id, 0]));
  for (const s of stories) for (const mid of s.moduleIds ?? []) if (perLeaf.has(mid)) perLeaf.set(mid, perLeaf.get(mid)! + 1);
  const fanout = [...perLeaf.values()];
  return {
    有产物: true,
    故事: stories.length,
    验收准则: criteria.length,
    每故事准则: +(criteria.length / Math.max(1, stories.length)).toFixed(2),
    // 词表是这把尺子的一部分：判定「要用户动手」先看通用动作动词，再看本项目的行业词表。
    词表: vocabulary.length,
    动作型: entries.filter((e) => e.actionable).length,
    动作型占比: pct(entries.filter((e) => e.actionable).length, entries.length),
    叶子: leaves.length,
    叶子扇出均值: +(fanout.reduce((a, b) => a + b, 0) / Math.max(1, leaves.length)).toFixed(2),
    空叶子: fanout.filter((n) => n === 0).length,
    待确认: criteria.filter((c) => /待确认/.test(c)).length,
    出处覆盖率: pct(criteria.filter((c) => /依据\s*\S+#\d+/.test(c)).length, criteria.length),
    角色: new Set(stories.map((s) => s.role).filter(Boolean)).size,
    机检发现: findings.length,
    机检按码: tally(findings, (f: any) => f.code),
  };
}

/** 文本用例：门禁自己的分与它点到的问题，外加 tier、负例比、孤儿与重复。 */
function textCases() {
  const gate = latest("validated/gate");
  const bundle = latest("validated/cases");
  if (!gate && !bundle) return { 有产物: false };
  const report = gate?.report ?? gate;
  const cases: any[] = bundle?.cases ?? [];
  const stats = report?.stats ?? {};
  return {
    有产物: true,
    用例: cases.length || stats.cases || 0,
    门禁分: report?.score !== undefined ? +report.score.toFixed(4) : undefined,
    过没过: gate?.passed,
    被扣分的用例: (report?.scoreBasis?.flagged ?? []).length,
    tier分布: stats.tiers ?? tally(cases, (c: any) => String(c.tier ?? "?")),
    负例比: stats.negativeRatio,
    负例比阈值: stats.minNegativeRatio,
    方法分布: stats.methods,
    孤儿: stats.orphans,
    重复: stats.duplicates,
    步数中位: median(cases.map((c) => (c.steps ?? []).length)),
    步数最大: cases.length ? Math.max(...cases.map((c) => (c.steps ?? []).length)) : 0,
    机检发现: (report?.findings ?? []).length,
    机检按码: tally(report?.findings ?? [], (f: any) => `${f.rule}/${f.severity}`),
  };
}

/** 用例代码：g2 编出来的东西——多少条用例有代码、自愈修了几轮、最后跑成什么样。 */
function caseCode() {
  const bundle = byName((n) => n.startsWith("g2/"));
  if (!bundle) return { 有产物: false, 说明: "这一跑没有 g2 产物（未走到批准后编译）" };
  const code: any[] = bundle.code ?? [];
  const repair = bundle.repair ?? {};
  return {
    有产物: true,
    有代码的用例: code.length,
    // 编译不出来的用例：它们批准了却进不了执行，是这个节点最该看的一个数。
    编译失败: (bundle.failed ?? []).length,
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

const card = {
  运行: runId,
  项目: projectId,
  产品结构: productStructure(),
  用户故事: userStories(),
  文本用例: textCases(),
  用例代码: caseCode(),
};

if (asJson) {
  console.log(JSON.stringify(card, null, 1));
} else {
  for (const [node, metrics] of Object.entries(card)) {
    if (typeof metrics !== "object" || metrics === null) {
      console.log(`${node}: ${metrics}`);
      continue;
    }
    console.log(`\n===== ${node} =====`);
    for (const [k, v] of Object.entries(metrics)) {
      if (v === undefined) continue;
      console.log(`  ${k.padEnd(16)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  }
}
