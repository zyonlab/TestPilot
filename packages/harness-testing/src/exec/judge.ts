/**
 * judge 判据的采样：对同一屏问几次，每次让模型对每条条件回答是或否。
 *
 * **为什么要轮换提问顺序。** 执行模型经 Midscene 调用，温度是 0.1（`@midscene/core`
 * 的 service-caller），同一屏同一句话连问三次几乎总得到同一个答案——那样「采样三次」
 * 什么都没测到。每次把条件换个顺序问，是压低顺序偏差、让不稳定的判断暴露出来的常见做法；
 * 回答再按原顺序对回去。
 *
 * 聚合在 `oracle.ts` 的 `aggregateJudge`（纯函数，会被复制进导出工程）；这里只负责问。
 */
import type { JudgeSampling, MachineOracle } from "./oracle.js";
import { judgePolicy } from "./oracle.js";

export type JudgeOracle = Extract<MachineOracle, { kind: "judge" }>;

/** Midscene agent 的 `aiQuery`：只用到这一个方法，测试里可以换成假的。 */
export interface JudgeAgent {
  aiQuery(demand: Record<string, string>, opt?: { domIncluded?: boolean | "visible-only"; screenshotIncluded?: boolean }): Promise<unknown>;
}

/** 第 `sample` 次采样的提问顺序：把条件轮转 `sample` 位。 */
export function judgeOrder(n: number, sample: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + sample) % n);
}

/** 一次采样的提问：键是 `c1…cn`（按这次的顺序），值说明要回答什么。 */
export function judgeDemand(criteria: string[], order: number[]): Record<string, string> {
  return Object.fromEntries(order.map((idx, pos) => [
    `c${pos + 1}`,
    `boolean。只看当前页面上真实可见的内容（文字与图片），判断下面这句话是否成立；看不到依据就答 false：${criteria[idx]}`,
  ]));
}

const TRUE = new Set(["true", "yes", "是", "成立", "1"]);
const FALSE = new Set(["false", "no", "否", "不成立", "0"]);
function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return TRUE.has(t) ? true : FALSE.has(t) ? false : undefined;
  }
  return undefined;
}

/** 把一次回答按原顺序还原；缺一条、答非所问都算这次采样无效。 */
export function readJudgeAnswer(answer: unknown, order: number[]): boolean[] | null {
  if (!answer || typeof answer !== "object") return null;
  const out: boolean[] = new Array(order.length);
  for (const [pos, idx] of order.entries()) {
    const b = asBool((answer as Record<string, unknown>)[`c${pos + 1}`]);
    if (b === undefined) return null;
    out[idx] = b;
  }
  return out;
}

export interface SampleJudgeOptions {
  /** 包一层模型准入（`withModel`）。 */
  call?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** 条件里可能带 `${env.*}` 占位符。 */
  resolve?: (text: string) => string;
  /** 这个报错是不是环境/端点的问题（`failure.ts` 的 isInfraError）。 */
  isInfra?: (message: string) => boolean;
  log?: (line: string) => void;
}

/**
 * 问 `samples` 次。返回采样结果，以及「是否全部采样都栽在环境上」——
 * 那种情况下这条判据根本没被判过，调用方应记成 infra，而不是 unobservable。
 */
export async function sampleJudge(agent: JudgeAgent, oracle: JudgeOracle, opts: SampleJudgeOptions = {}): Promise<{ sampling: JudgeSampling; infra: boolean; infraMessage?: string }> {
  const { samples } = judgePolicy(oracle);
  const criteria = oracle.criteria.map((c) => (opts.resolve ? opts.resolve(c) : c));
  const call = opts.call ?? (<T>(fn: () => Promise<T>) => fn());
  const verdicts: Array<boolean[] | null> = [];
  const errors: string[] = [];
  let infraCount = 0;
  let infraMessage: string | undefined;
  for (let s = 0; s < samples; s++) {
    const order = judgeOrder(criteria.length, s);
    try {
      const answer = await call(() => agent.aiQuery(judgeDemand(criteria, order), { domIncluded: "visible-only", screenshotIncluded: true }));
      const read = readJudgeAnswer(answer, order);
      verdicts.push(read);
      if (!read) errors.push(`第 ${s + 1} 次采样答非所问：${JSON.stringify(answer).slice(0, 160)}`);
      opts.log?.(`judge sample ${s + 1}/${samples}: ${read ? read.map((b) => (b ? "✓" : "✗")).join("") : "∅"}`);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      verdicts.push(null);
      errors.push(`第 ${s + 1} 次采样出错：${message.slice(0, 160)}`);
      if (opts.isInfra?.(message)) { infraCount++; infraMessage ??= message; }
      opts.log?.(`judge sample ${s + 1}/${samples}: error ${message.slice(0, 80)}`);
    }
  }
  return { sampling: { verdicts, errors }, infra: infraCount === samples, infraMessage };
}
