import { compareDecimal, compareDecimalChange } from './decimal.js';
import { z } from "zod";

/**
 * Machine-checkable oracles: the part of a verdict a program can settle.
 *
 * Stage one has always labelled every case with a tier — 1 = a program can settle it,
 * 2 = a relation between two observations, 3 = a model has to look. Stage two had exactly
 * one way to check anything: `aiAssert`, which is a model looking at a screenshot. So the
 * tier was a claim with nothing behind it, and a case labelled tier 1 got a tier-3 verdict
 * that moved between runs. (Measured: the same four bootstrap cases, three runs, a
 * different one passing each time.)
 *
 * These are the forms that need no selector and no model, which is what makes them usable
 * from an end-agnostic text case:
 *   text / noText   a literal string the interface shows, or must not show
 *   url             where the run ended up
 *   count           how many times a literal appears
 *   delta           a number beside a label, compared with before the steps ran (tier 2)
 *
 * Anything needing an element identified by description stays with the judge — that is the
 * honest boundary, and pretending otherwise would put a model back inside a "tier 1" check.
 */

export const MachineOracleSchema = z.discriminatedUnion("kind", [
  /**
   * `none`：tier 3 用的那一个——**判决要模型看一眼屏幕**，没有程序能核对的形式。
   *
   * 2026-09-13 之前这个 union 里没有它，而 skill 明写着「tier 3 写 `{"kind":"none"}`」、
   * 受限解码的枚举里也有 `none`。三处清单互相打架：模型照 skill 与解码枚举发出 `none`，
   * 校验一律 `Invalid discriminator value` 拒收；反过来红线禁止的 `api` 校验反而放行。
   * 实测 Claude 臂提交 75 条用例，4 条 tier 3 全被这一条挡住。
   *
   * 它不是「一种机器判据」——`tierOf` 照旧把它算作 3，`exec` 走判屏那条路。
   * 有它只是为了让「这条用例明说自己没有机器判据」这句话写得出来。
   */
  z.object({ kind: z.literal("none") }),
  /**
   * `judge`：给**生成出来的东西**用的判据——图、文案、摘要这类每次都不一样、程序核对不了的输出。
   *
   * 原来 tier 3 只有一句 `aiAssert(expected)`：模型看一眼，给一个是/否，不打分、不采样。
   * 同一张图问两次答案不一样时，那条用例就是随机的，而报告里看不出来。
   *
   * 这里把「看一眼」拆开：
   * - `criteria`：几句**能对着屏幕回答是或否**的话（「图里有一只猫」「标题不超过 20 个字」），
   *   不是「看起来不错」。一句一个判断，报告能说出是哪一句不成立。
   * - `samples`：问几次（每次轮换提问顺序，见 `exec/judge.ts`），默认 3。
   * - `minPass`：至少几次采样**全部条件成立**才算过；默认过半。
   *
   * 判决按统计口径给（`aggregateJudge`）：够数算过；采样失败的次数足以翻盘时算「没量到」，
   * 不算过也不算挂。每条条件的成立率与意见分歧都写进 detail。它永远是 tier 3。
   */
  z.object({
    kind: z.literal("judge"),
    criteria: z.array(z.string().min(1)).min(1).max(8),
    samples: z.number().int().min(1).max(9).default(3),
    minPass: z.number().int().min(1).max(9).optional(),
  }),
  z.object({ kind: z.literal("text"), value: z.string().min(1) }),
  z.object({ kind: z.literal("noText"), value: z.string().min(1) }),
  z.object({ kind: z.literal("url"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("count"),
    value: z.string().min(1),
    op: z.enum(["eq", "gte", "lte"]).default("eq"),
    n: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("delta"),
    /** The label the number sits beside, e.g. "重启次数". */
    value: z.string().min(1),
    direction: z.enum(["increased", "decreased", "unchanged"]),
    /** Optional exact size of the change. */
    by: z.number().optional(),
  }),
  /**
   * api：问一个 JSON 接口，而不是看屏幕。见 `apiOracle.ts`。
   *
   * 交易页的真值（持仓、挂单、余额）在接口里是精确的数，在屏幕上是会随行情变的字。
   * `eq/neq/gte/lte/exists/absent` 是 tier 1；`increased/decreased/unchanged` 比较步骤前后
   * 两次读数，是 tier 2。
   */
  z.object({
    kind: z.literal("api"),
    /** 接口地址，可含 ${env.*} / ${secret.*}。 */
    url: z.string().min(1),
    method: z.enum(["GET", "POST"]).default("GET"),
    /** POST 的 JSON 正文（字符串），可含占位符。 */
    body: z.string().optional(),
    headers: z.record(z.string()).optional(),
    /** 响应 JSON 里的点分路径，数组下标用数字：`assetPositions.0.position.szi`。 */
    path: z.string().min(1),
    op: z.enum(["eq", "neq", "gte", "lte", "exists", "absent", "increased", "decreased", "unchanged"]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Decimal strings preserve small increments and large account quantities. */
    by: z.union([z.number().nonnegative(), z.string().regex(/^\d+(?:\.\d+)?$/)]).optional(),
    unit: z.object({ path: z.string().min(1), value: z.string().min(1) }).optional(),
    freshness: z.object({ timestampPath: z.string().min(1), maxAgeMs: z.number().int().positive() }).optional(),
    /** 取值前等多久（毫秒）。交易所接口在下单后有传播延迟。 */
    settleMs: z.number().int().min(0).optional(),
  }),
]);
export type MachineOracle = z.infer<typeof MachineOracleSchema>;

/** What the page looked like at one moment. Text and URL only — no DOM, no selectors. */
export interface PageSnapshot {
  text: string;
  url: string;
  /** 只有 api 判据会填：对接口的一次观察。见 `apiOracle.ts`。 */
  api?: { value?: unknown; error?: string };
  /** 只有 judge 判据会填：这一屏上的几次采样。见 `exec/judge.ts`。 */
  judge?: JudgeSampling;
}

/**
 * judge 判据的采样结果：每次采样对每条条件给一个是/否，按 `criteria` 的原顺序。
 * `null` 是这次采样没拿到可用的答案（调用出错、答非所问、条数对不上）。
 */
export interface JudgeSampling {
  verdicts: Array<boolean[] | null>;
  errors?: string[];
}

export interface JudgeStats {
  samples: number;
  valid: number;
  passed: number;
  minPass: number;
  /** 每条条件在有效采样里成立的次数。 */
  perCriterion: number[];
  /** 有效采样之间意见不一：有的全部成立，有的没有。 */
  split: boolean;
}

/** 采样次数与及格线：`minPass` 缺省为过半，并夹在 [1, samples] 之内。 */
export function judgePolicy(oracle: { samples?: number; minPass?: number }): { samples: number; minPass: number } {
  const samples = Math.max(1, Math.min(9, Math.floor(oracle.samples ?? 3)));
  const minPass = Math.max(1, Math.min(samples, Math.floor(oracle.minPass ?? Math.floor(samples / 2) + 1)));
  return { samples, minPass };
}

/**
 * 把几次采样合成一个判决。
 *
 * - 全部条件成立的采样 ≥ `minPass` → pass；
 * - 即使把失败的采样都算成成立也够不到 `minPass` → fail；
 * - 其余（失败的采样足以翻盘）→ unobservable：这次没量到，不是产品错了。
 */
export function aggregateJudge(
  oracle: { criteria: string[]; samples?: number; minPass?: number },
  sampling: JudgeSampling,
): OracleVerdict & { judge: JudgeStats } {
  const { samples, minPass } = judgePolicy(oracle);
  const n = oracle.criteria.length;
  const valid = sampling.verdicts.filter((v): v is boolean[] => Array.isArray(v) && v.length === n);
  const invalid = Math.max(0, samples - valid.length);
  const passed = valid.filter((v) => v.every(Boolean)).length;
  const perCriterion = oracle.criteria.map((_, i) => valid.filter((v) => v[i]).length);
  const split = passed > 0 && passed < valid.length;
  const judge: JudgeStats = { samples, valid: valid.length, passed, minPass, perCriterion, split };
  const rates = oracle.criteria.map((c, i) => `「${c}」${perCriterion[i]}/${valid.length}`).join("；");
  const tail = `${split ? "；各次采样意见不一" : ""}${invalid ? `；${invalid} 次采样没拿到答案` : ""}`;
  const head = `${passed}/${samples} 次采样全部条件成立（至少要 ${minPass}）`;
  if (passed >= minPass) return { status: "pass", detail: `${head}：${rates}${tail}`, judge };
  if (passed + invalid >= minPass)
    return { status: "unobservable", detail: `${head}，失败的采样足以翻盘，这次不下判决：${rates}${tail}`, judge };
  return { status: "fail", detail: `${head}：${rates}${tail}`, judge };
}

/**
 * Which tier this oracle actually delivers.
 *
 * The point of having it: a case can now be *checked* against its own claim, instead of
 * the claim being taken at face value.
 */
export function tierOf(oracle: MachineOracle): 1 | 2 | 3 {
  // judge 是模型判的，只是判得更有章法：它交付的永远是 tier 3。
  if (oracle.kind === "judge") return 3;
  if (oracle.kind === "delta") return 2;
  if (oracle.kind === "api") return oracle.op === "increased" || oracle.op === "decreased" || oracle.op === "unchanged" ? 2 : 1;
  return 1;
}

export function describeOracle(oracle: MachineOracle): string {
  switch (oracle.kind) {
    // 明说自己没有机器判据的那一种：执行时由模型看屏幕表态（tier 3）。
    case "none":
      return "由模型看屏幕判定（没有机器判据）";
    case "judge": {
      const { samples, minPass } = judgePolicy(oracle);
      return `模型按 ${oracle.criteria.length} 条条件判 ${samples} 次，至少 ${minPass} 次全部成立：${oracle.criteria.join("；")}`;
    }
    case "text":
      return `页面显示「${oracle.value}」`;
    case "noText":
      return `页面不显示「${oracle.value}」`;
    case "url":
      return `地址包含 ${oracle.value}`;
    case "count": {
      const op = oracle.op === "eq" ? "等于" : oracle.op === "gte" ? "不少于" : "不多于";
      return `「${oracle.value}」出现次数${op} ${oracle.n}`;
    }
    case "delta": {
      const dir =
        oracle.direction === "increased" ? "增加" : oracle.direction === "decreased" ? "减少" : "不变";
      return `${oracle.value} 的数值${dir}${oracle.by !== undefined ? ` ${oracle.by}` : ""}`;
    }
    case "api": {
      const what = `接口 ${oracle.path}`;
      switch (oracle.op) {
        case "eq":
          return `${what} 等于 ${String(oracle.value)}`;
        case "neq":
          return `${what} 不等于 ${String(oracle.value)}`;
        case "gte":
          return `${what} 不少于 ${String(oracle.value)}`;
        case "lte":
          return `${what} 不多于 ${String(oracle.value)}`;
        case "exists":
          return `${what} 存在`;
        case "absent":
          return `${what} 不存在`;
        case "increased":
          return `${what} 增加${oracle.by !== undefined ? ` ${oracle.by}` : ""}`;
        case "decreased":
          return `${what} 减少${oracle.by !== undefined ? ` ${oracle.by}` : ""}`;
        case "unchanged":
          return `${what} 不变`;
      }
    }
  }
}

/** Occurrences of a literal, counted on the page's visible text. */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let from = 0;
  let n = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

/**
 * The number that sits beside a label.
 *
 * Deliberately simple and deliberately explicit about failing: if the label appears twice
 * with different numbers, or the text beside it is not a number, this returns undefined and
 * the check reports that it could not read the value — rather than guessing, which is how a
 * "deterministic" oracle quietly becomes a coin flip.
 */
export function readNumberNear(text: string, label: string): number | undefined {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(label, from);
    if (at === -1) break;
    from = at + label.length;
    const after = text.slice(from, from + 40);
    const m = after.match(/-?\d+(?:[.,]\d+)?/);
    if (m) found.push(Number(m[0].replace(",", "")));
  }
  if (!found.length) return undefined;
  return found.every((v) => v === found[0]) ? found[0] : undefined;
}

export interface OracleVerdict {
  /**
   * `unobservable`：判据没法求值——不是产品错了，是这次没量到。
   *
   * 借 commerce-agents 的「None ≠ 0」：取不到的指标是 None 加一句 note，不许拿 0 顶替。
   * 此前这一档被记成 `fail`，于是「没取到前置快照」「读不到那个数」都算成了产品的错，
   * 而 M2 三次通过的用例各不相同，有一部分正是这类不可观测被判成了失败。
   * 它单独成一档，执行结果里单独计数，变异检测把它排除在分母外——和 infra 故障一样，
   * 「没有判决」不进任何一格。
   */
  status: "pass" | "fail" | "unobservable";
  /** Why, in terms of what was actually on the page. */
  detail: string;
  /** 只有 judge 判据有：采样统计。 */
  judge?: JudgeStats;
}

export function evaluateOracle(
  oracle: MachineOracle,
  after: PageSnapshot,
  before?: PageSnapshot,
): OracleVerdict {
  switch (oracle.kind) {
    /**
     * `none` 不是一个能跑的判据：它宣称的正是「这里没有机器判据」。
     * 交给判屏那条路，而不是在这里假装判过——`skipped` 和 `pass` 不是一回事。
     */
    case "none":
      return { status: "unobservable", detail: "tier 3：没有机器判据，交由判屏" };
    case "judge":
      return after.judge ? aggregateJudge(oracle, after.judge) : { status: "unobservable", detail: "judge 判据没有采样结果" };
    case "text": {
      const hit = after.text.includes(oracle.value);
      return {
        status: hit ? "pass" : "fail",
        detail: hit ? `找到「${oracle.value}」` : `页面上没有「${oracle.value}」`,
      };
    }
    case "noText": {
      const hit = after.text.includes(oracle.value);
      return {
        status: hit ? "fail" : "pass",
        detail: hit ? `页面上仍有「${oracle.value}」` : `确认没有「${oracle.value}」`,
      };
    }
    case "url": {
      const hit = after.url.includes(oracle.value);
      return {
        status: hit ? "pass" : "fail",
        detail: hit ? `地址 ${after.url}` : `地址是 ${after.url}，不含 ${oracle.value}`,
      };
    }
    case "count": {
      const n = occurrences(after.text, oracle.value);
      const ok = oracle.op === "eq" ? n === oracle.n : oracle.op === "gte" ? n >= oracle.n : n <= oracle.n;
      return { status: ok ? "pass" : "fail", detail: `「${oracle.value}」出现 ${n} 次（要求 ${oracle.op} ${oracle.n}）` };
    }
    case "delta": {
      if (!before)
        // A relation needs two observations. Reporting "fail" here would blame the product
        // for something the harness failed to measure.
        return { status: "unobservable", detail: `没有取到步骤执行前的快照，${oracle.value} 的变化无法判定` };
      const a = readNumberNear(before.text, oracle.value);
      const b = readNumberNear(after.text, oracle.value);
      if (a === undefined || b === undefined)
        return {
          status: "unobservable",
          detail: `读不到 ${oracle.value} 旁边的数值（前 ${a ?? "—"} / 后 ${b ?? "—"}）`,
        };
      const diff = b - a;
      const ok =
        oracle.direction === "increased"
          ? oracle.by !== undefined
            ? diff === oracle.by
            : diff > 0
          : oracle.direction === "decreased"
            ? oracle.by !== undefined
              ? diff === -oracle.by
              : diff < 0
            : diff === 0;
      return { status: ok ? "pass" : "fail", detail: `${oracle.value}: ${a} → ${b}（Δ ${diff}）` };
    }
    case "api": {
      const obs = after.api;
      // 没去问、或问了没读到：是 harness 没量到，不是产品错了。
      if (!obs) return { status: "unobservable", detail: `没有对接口 ${oracle.path} 的观察` };
      const relational = oracle.op === "increased" || oracle.op === "decreased" || oracle.op === "unchanged";
      if (oracle.op === "absent") {
        // 「不存在」是唯一一个把「读不到」当成结果的判据：路径落空正是它要的。
        // JSON 接口说「没有」有两种写法：键不在（路径落空）与 `null`（demo 的 mock、不少 REST 接口）。两种都是没有。
        const gone = (obs.value === undefined && (obs.error ?? "").startsWith("响应里没有")) || obs.value === null;
        if (gone) return { status: "pass", detail: `接口里没有 ${oracle.path}` };
        if (obs.error) return { status: "unobservable", detail: obs.error };
        return { status: "fail", detail: `接口里仍有 ${oracle.path} = ${JSON.stringify(obs.value)}` };
      }
      if (obs.error || obs.value === undefined) return { status: "unobservable", detail: obs.error ?? `读不到 ${oracle.path}` };
      if (oracle.op === "exists")
        return obs.value === null
          ? { status: "fail", detail: `${oracle.path} 是 null——接口说它不存在` }
          : { status: "pass", detail: `${oracle.path} = ${JSON.stringify(obs.value)}` };
      if (!relational) {
        const v = obs.value;
        const want = oracle.value;
        if (want === undefined) return { status: "unobservable", detail: "API 判据缺少预期 value" };
        const comparison = compareDecimal(v, want);
        if ((typeof v === "number" || typeof want === "number") && comparison === undefined && (typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER || typeof want === "number" && Math.abs(want) > Number.MAX_SAFE_INTEGER)) return { status: "unobservable", detail: "API 数值超过安全精度；请使用十进制字符串" };
        const equal = comparison === 0 || (comparison === undefined && typeof v === typeof want && v === want);
        let ok: boolean;
        if (oracle.op === "eq") ok = equal;
        else if (oracle.op === "neq") ok = !equal;
        else if (comparison === undefined)
          return { status: "unobservable", detail: `${oracle.path} = ${JSON.stringify(v)}，不是数，无法比大小` };
        else ok = oracle.op === "gte" ? comparison! >= 0 : comparison! <= 0;
        return { status: ok ? "pass" : "fail", detail: `${oracle.path} = ${JSON.stringify(v)}（要求 ${oracle.op} ${String(want)}）` };
      }
      if (!before?.api) return { status: "unobservable", detail: `没有取到步骤执行前的接口读数，${oracle.path} 的变化无法判定` };
      if (before.api.error || before.api.value === undefined)
        return { status: "unobservable", detail: `步骤前读不到 ${oracle.path}：${before.api.error ?? "空"}` };
      const relation = compareDecimal(obs.value, before.api.value);
      if (relation === undefined) return { status: "unobservable", detail: `${oracle.path} 无法精确比较；数值须为有效十进制或安全数字` };
      const change = oracle.by === undefined ? undefined : String(oracle.by);
      const ok = oracle.op === "unchanged" ? relation === 0
        : oracle.op === "increased" ? change === undefined ? relation > 0 : compareDecimalChange(before.api.value, obs.value, change) === 0
        : change === undefined ? relation < 0 : compareDecimalChange(before.api.value, obs.value, `-${change}`) === 0;
      return { status: ok ? "pass" : "fail", detail: `${oracle.path}: ${before.api.value} → ${obs.value}（精确十进制比较）` };
    }
  }
}
