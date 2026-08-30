import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dataPath } from "./datadir.js";

/**
 * 变异实验的结果，按它跑的那次运行存着。
 *
 * 为什么单独存而不做成一个图节点：变异实验是**对着一批已经生成好的用例反复跑**，
 * 它的自然单位不是「一次工作流」，而是「一套用例 × N 个变异体」。做成节点会逼着
 * 每跑一次变异就重走一遍生成，而生成才是贵的那一半。
 *
 * 存成文件而不是入库，是因为它要能被人直接打开看：一份「哪些缺陷没人抓得到」的清单，
 * 值得能 `cat` 出来。
 */

export interface MutationSurvivor {
  what: string;
  from: string;
  target?: string;
}

export interface MutationReport {
  wfRunId: string;
  at: string;
  killed: number;
  survived: number;
  /** 生效了、但这一轮有用例根本没跑成——不知道抓没抓住，不进分母。 */
  inconclusive?: number;
  notApplied: number;
  /** 分母只算「生效了、且这一轮跑得干净」的变异体。其余的是不知道，不是零分。 */
  score: number;
  /** 跑了哪些用例。样本太小的得分不该被当成结论，所以这个数要跟着报。 */
  cases: number;
  /**
   * 干净跑那一轮就挂掉的用例数——**读懂 0 分的第一个数字**。
   *
   * 它们进了基线失败集，永远不可能构成 kill：一条本来就挂的用例再挂一次，说明不了
   * 任何关于变异体的事。所以真正「有机会叫」的只有 `cases - baselineFailed` 条。
   *
   * 实测撞到过：8 条用例干净跑挂了 4 条（2 条还是 infra），报告只写了 `score: 0`。
   * 那个 0 读起来是「这套用例什么都抓不到」，事实是「一半的用例集根本没上场」。
   * 一个干净的数字盖住「这次实验有一半是坏的」，是这套东西里反复出现的同一种病。
   */
  baselineFailed: number;
  /** 上面那些里有几条是基础设施故障（模型不可达、浏览器崩）——它们连产品都没碰到。 */
  baselineInfra: number;
  /** `cases - baselineFailed`：真正有机会叫的条数。0 的时候整份报告不成立。 */
  usableCases: number;
  /**
   * 基线里因为基础设施故障重试过几条。
   *
   * 报出来是因为它是**这份报告可信度的一部分**：基线抖得越多，说明这一轮的环境越不稳，
   * 而基线一旦挂掉，那条用例整场都不再算数——一次模型抖动的代价不是「这次不算」，
   * 是「它整场都不上场」。
   */
  baselineRetried: number;
  /**
   * 用例来自哪一次运行（与产品模型不是同一次时才有）。
   *
   * 流水线本来就是两段：图与规格在 g0/g1，可执行代码在 g2。一次结果说不清它的输入，
   * 就不是一次结果——所以这个字段跟着报告走。
   */
  codeFrom?: string;
  survivors: MutationSurvivor[];
}

const fileFor = (wfRunId: string): string => resolve(dataPath("mutation"), `${wfRunId}.json`);

export function saveMutationReport(r: MutationReport): void {
  const f = fileFor(r.wfRunId);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 1), "utf8");
}

/** 没跑过变异实验就返回 undefined——**不是返回一个 0 分**。 */
export function readMutationReport(wfRunId: string): MutationReport | undefined {
  const f = fileFor(wfRunId);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as MutationReport;
  } catch {
    return undefined;
  }
}
