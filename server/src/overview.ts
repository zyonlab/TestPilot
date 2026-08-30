import { listCases, listProjects, type Priority } from "./db.js";
import { allOutputs, outputStore } from "./graphs.js";

/**
 * 一个项目此刻有什么。
 *
 * 存在的理由是一处**两套账**：候选产物挂在运行上，已批准资产挂在项目上。代码里分得很清楚
 * ——`graphs.ts` 甚至写了注释「候选没有看板优先级，声称一个就是在编造事实」——可是界面上
 * 两者都叫「用例」「代码」，于是每个数字都在跟另一个数字打架：
 *
 *   画布说「用例代码 38」，点进代码线说「这个项目还没有一条用例带代码」0/0；
 *   画布说「文本用例 40」，点进看板说「这个项目还没有用例」；
 *   交付页说「0 条用例 · 8 个文件」，而下载按钮是可点的。
 *
 * 三处症状，一个根因：**没有一个查询把两边一起数**。`listProjects()` 只算已批准那一半，
 * 而候选那一半明明是数得出来的——`wf_runs` 上有 `projectId`。
 *
 * 所以这里两边都数，并且**永远各带各的标签**。合成一个数是更糟的做法：那会让「40 条用例」
 * 这句话继续骗人，只是骗得更圆滑。
 */

export interface ProjectOverview {
  projectId: string;
  /** 已经有人看过并且认可的那些。这是「我们的套件」。 */
  approved: {
    cases: number;
    withCode: number;
    byPriority: Record<Priority, number>;
    /** 有机器判据的条数——套件里有多少不需要问模型就能判。 */
    machineDecidable: number;
  };
  /**
   * 工作流跑出来、还没人表过态的那些。这是「等着被看的东西」。
   *
   * `cases`/`code` 是**最近一次运行**的条数，不是所有运行的和。求和会得到一个没有意义的
   * 大数：同一批用例重跑四十次，和出来是一千五百多条，而实际等着被看的只有最近那四十条。
   * 一个大得没道理的数字比没有数字更糟——它会被当成工作量，然后被放弃。
   */
  candidates: {
    /** 绑在这个项目上的运行数。 */
    runs: number;
    /** 其中产出过用例的运行数。 */
    runsWithCases: number;
    /** 最近一次运行的候选用例条数。 */
    cases: number;
    /** 最近一次运行生成了代码的条数。 */
    code: number;
    latestRunId?: string;
    latestAt?: string;
  };
}

/** 一次运行的产物里能数出什么。数不出来就说数不出来，不猜。 */
interface RunCounts {
  cases: number;
  code: number;
}

function countsOf(outputs: Record<string, unknown>): RunCounts {
  let cases = 0;
  let code = 0;
  for (const value of Object.values(outputs)) {
    if (!value || typeof value !== "object") continue;
    const o = value as { cases?: unknown; code?: unknown };
    // 一次运行里好几个节点都带着同一批用例（gate 拿到的就是 design 产出的那一批），
    // 所以取最大值而不是求和——求和会把同一批数好几遍。
    if (Array.isArray(o.cases)) cases = Math.max(cases, o.cases.length);
    if (Array.isArray(o.code)) code = Math.max(code, o.code.length);
  }
  return { cases, code };
}

const projectOf = (run: { detail?: unknown; projectId?: string }): string | undefined => {
  if (run.projectId) return run.projectId;
  const target = (run.detail as { target?: { projectId?: string } } | undefined)?.target;
  return target?.projectId;
};

export async function projectOverview(projectId: string): Promise<ProjectOverview> {
  const cases = listCases(projectId);
  const byPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0 };
  for (const c of cases) byPriority[c.priority] = (byPriority[c.priority] ?? 0) + 1;

  const runs = outputStore
    .listRuns()
    .filter((r) => projectOf(r as { detail?: unknown; projectId?: string }) === projectId);

  let runsWithCases = 0;
  let latest: { id: string; at: string; counts: RunCounts } | undefined;

  for (const r of runs) {
    const run = r as { id: string; startedAt?: string };
    const outputs = await allOutputs(run.id).catch(() => ({}) as Record<string, unknown>);
    const n = countsOf(outputs);
    if (!n.cases && !n.code) continue;
    if (n.cases) runsWithCases += 1;
    const at = run.startedAt ?? "";
    if (!latest || at > latest.at) latest = { id: run.id, at, counts: n };
  }

  return {
    projectId,
    approved: {
      cases: cases.length,
      withCode: cases.filter((c) => c.hasCode).length,
      byPriority,
      machineDecidable: cases.filter((c) => !!c.oracle).length,
    },
    candidates: {
      runs: runs.length,
      runsWithCases,
      cases: latest?.counts.cases ?? 0,
      code: latest?.counts.code ?? 0,
      latestRunId: latest?.id,
      latestAt: latest?.at,
    },
  };
}

/**
 * 所有项目的概览。
 *
 * 项目列表用它——那三张写着「还没有用例」的卡片就是这一条查询缺席的直接后果。
 * 逐个跑而不是并发：产物读的是磁盘上的 JSON，并发在这里买不到什么，
 * 却会让一个项目多的库一次打开几百个文件。
 */
export async function allProjectOverviews(): Promise<Record<string, ProjectOverview>> {
  const out: Record<string, ProjectOverview> = {};
  for (const p of listProjects()) out[p.id] = await projectOverview(p.id);
  return out;
}
