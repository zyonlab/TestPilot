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
