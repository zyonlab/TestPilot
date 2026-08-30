import {
  buildMutationScript,
  generateMutants,
  judgeMutant,
  scoreMutants,
  survivorsAsGaps,
  type CaseOutcome,
  type Mutant,
  type MutantResult,
} from "@testpilot/harness-testing";
import { executeCaseDirect, nodeOutput, outputStore, type RunTarget } from "./graphs.js";
import { saveMutationReport, type MutationReport } from "./mutation.js";
import { bus } from "./procs.js";

/**
 * 跑一次变异测试，并把报告存下来。
 *
 * **这个文件存在的理由是：在它之前，变异那条路径是只读的。**
 * `mutate/` 模块（算子、注入、判决、计分）齐全，`readMutationReport` 能读，
 * 复核界面能显示，缺口能标在故事图上——可是 `saveMutationReport` 全仓库零调用。
 * 盘上那两份报告（0.6 / 0.5）的生产者已经不在代码里了。也就是说这个产品最强的一处
 * 能力**不可重跑**：那个 0.600 是一次性的、没人能验证的数字。
 *
 * 三件事这里必须做对，每一件都有前车之鉴：
 *
 * ① **先跑一遍干净的。**没有基线就分不清「这条用例是被变异体搞挂的」和「它本来就挂」。
 *    `judgeMutant` 要的正是这个集合。
 *
 * ② **「没生效」和「活下来」必须分开。**注入脚本自己记账（`window.__tpMutation.applied`），
 *    0 处就是 `notApplied`，不进分母。混为一谈会把工具自己的失败伪装成用例集的盲区，
 *    而虚低的那部分看起来像真发现——那是这套东西里最坏的一种错。
 *
 * ③ **变异注在浏览器里，不注在被测应用里。**被测应用一个字节都不改，容器不重建。
 *    这既是黑盒变异测试成立的前提，也是它能对任何产品用的原因——
 *    `/api/evals/detection` 那条老路径靠被测应用自己实现 `?defect=`，
 *    于是指向任何真实产品都会静悄悄地退化成「跑了一整轮健康版」。
 */

export interface MutationRunRequest {
  wfRunId: string;
  /** 从哪个节点取可执行用例。默认 `repair`（阶段二修完之后的那一版）。 */
  node?: string;
  /** 每类算子最多产几个变异体。成本 = 变异体数 × 跑一遍用例集。 */
  limit?: number;
  /** 用几条用例跑。变异测试的成本几乎全在这里。 */
  cases?: number;
  target?: RunTarget;
}

interface CodeCase {
  caseId: string;
  title: string;
  actions: unknown[];
  uses: string[];
}

/** 一次变异测试的进度事件。跑一轮要几十分钟，没有进度就只能盯着日志猜。 */
const emit = (kind: string, payload: Record<string, unknown>): void => {
  bus.publish(`mutation.${kind}`, payload, {});
};

export async function runMutation(req: MutationRunRequest): Promise<MutationReport> {
  const { wfRunId } = req;
  const node = req.node ?? "repair";

  const bundle = (await nodeOutput(wfRunId, node)) as
    | { code?: CodeCase[]; fragments?: Array<{ name: string; actions: unknown[] }> }
    | undefined;
  const code = (bundle?.code ?? []).slice(0, req.cases ?? 12);
  if (!code.length) throw new Error(`运行 ${wfRunId} 的 ${node} 节点里没有可执行用例`);
  const fragments = bundle?.fragments ?? [];

  /**
   * 变异体从**产品模型和规格**生成，用例集不参与。
   *
   * 这一条是变异测试成立的关键：如果变异体是从用例生成的，那量的就是「用例能不能
   * 抓到它自己」——一个必然为真的循环。所以取的是探索得到的状态图与整理后的规格。
   */
  const graph = ((await nodeOutput(wfRunId, "explore").catch(() => undefined)) as
    | { graph?: unknown }
    | undefined)?.graph;
  const spec = (await nodeOutput(wfRunId, "spec").catch(() => undefined)) as
    | { rules?: Array<{ id: string; text: string; evidence?: string }> }
    | undefined;
  const mutants: Mutant[] = generateMutants(
    { graph: graph as never, spec: spec as never },
    req.limit ?? 4,
  );
  if (!mutants.length)
    throw new Error(
      `从 ${wfRunId} 的图与规格里生成不出变异体——多半是这次运行没有探索节点（图为空），` +
        `或者规格里没有带引号的界面文案。变异体必须来自产品本身，不能从用例生成。`,
    );

  const target = req.target ?? (outputStore.getRun(wfRunId)?.detail as { target?: RunTarget } | undefined)?.target;
  if (!target?.url) throw new Error(`运行 ${wfRunId} 没有记录目标地址，不知道该对谁注变异体`);

  const runCase = async (c: CodeCase, mutation?: { id: string; script: string }): Promise<CaseOutcome & { applied?: number }> => {
    const out = await executeCaseDirect(target, c, fragments as never, mutation);
    return {
      caseId: c.caseId,
      status: out.status === "passed" ? "passed" : "failed",
      failKind: out.failKind,
      applied: out.mutationApplied,
    };
  };

  emit("started", { wfRunId, mutants: mutants.length, cases: code.length });

  // ① 干净跑。它决定「这条用例本来就挂着」，没有它整个判决都不成立。
  const clean: CaseOutcome[] = [];
  for (const c of code) clean.push(await runCase(c));
  emit("baseline", { wfRunId, failed: clean.filter((c) => c.status === "failed").length, of: clean.length });

  // ② 每个变异体一轮。
  const results: MutantResult[] = [];
  for (const m of mutants) {
    const script = buildMutationScript(m);
    const mutated: CaseOutcome[] = [];
    let applied = 0;
    for (const c of code) {
      const out = await runCase(c, { id: m.id, script });
      mutated.push({ caseId: out.caseId, status: out.status, failKind: out.failKind });
      // 一轮里只要有一次真的改到了，这个变异体就算生效过——
      // 有些改动只在提交表单之后那一屏才存在，入口页那几条用例改不到它。
      applied = Math.max(applied, out.applied ?? 0);
    }
    const r = judgeMutant(m, applied, clean, mutated);
    results.push(r);
    emit("mutant", { wfRunId, id: m.id, operator: m.operator, verdict: r.verdict, applied });
  }

  const score = scoreMutants(results);
  const report: MutationReport = {
    wfRunId,
    at: new Date().toISOString(),
    killed: score.killed,
    survived: score.survived,
    inconclusive: score.inconclusive,
    notApplied: score.notApplied,
    score: score.score,
    cases: code.length,
    survivors: survivorsAsGaps(score),
  };
  saveMutationReport(report);
  emit("done", { wfRunId, score: score.score, denom: score.denom });
  return report;
}
