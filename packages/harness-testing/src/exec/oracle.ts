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
]);
export type MachineOracle = z.infer<typeof MachineOracleSchema>;

/** What the page looked like at one moment. Text and URL only — no DOM, no selectors. */
export interface PageSnapshot {
  text: string;
  url: string;
}

/**
 * Which tier this oracle actually delivers.
 *
 * The point of having it: a case can now be *checked* against its own claim, instead of
 * the claim being taken at face value.
 */
export function tierOf(oracle: MachineOracle): 1 | 2 {
  return oracle.kind === "delta" ? 2 : 1;
}

export function describeOracle(oracle: MachineOracle): string {
  switch (oracle.kind) {
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
}

export function evaluateOracle(
  oracle: MachineOracle,
  after: PageSnapshot,
  before?: PageSnapshot,
): OracleVerdict {
  switch (oracle.kind) {
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
  }
}
