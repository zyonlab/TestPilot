/**
 * 自愈退化检测（07 T-16）：一次「修复」有没有把用例改弱。
 *
 * 《Practical Limits of Autonomous Test Repair》里 7 个「成功」2 个是假的：`toBe(5)`→`toBeTruthy()`、静默删测试。
 * 文本用例的等价物是：判据没了或换成更弱的一种、层级掉了、`expected` 变短且丢了字面量、用例被删。
 * 这里只**比较前后**并说出改了什么；要不要拦由入口决定（网关：自愈路径不允许改 oracle，改了就拦回人）。
 * 和 `repair.ts` 的 `assertionWeakened` 是同一个思路的两层：那边看代码用例的 assert 动作，这边看文本用例的判据。
 */
import type { MachineOracle } from "../exec/oracle.js";
import { tierOf } from "../exec/oracle.js";

export interface DegradableCase {
  id: string;
  expected?: string;
  tier?: number;
  oracle?: MachineOracle;
  steps?: Array<{ text: string } | string>;
}

export type DegradeKind = "case-removed" | "oracle-removed" | "oracle-weakened" | "tier-dropped" | "expected-vague";

export interface DegradeFinding {
  kind: DegradeKind;
  detail: string;
}

const literals = (s: string): string[] => [...s.matchAll(/[「『"'`“”]([^」』"'`“”]{2,})[」』"'`“”]/g)].map((m) => m[1]);

/** 判据强度：api / text / url / noText / count 是一次观察（1），delta 与 api 的关系型是两次（2），没有是 3。 */
const strength = (o?: MachineOracle): number => (o ? tierOf(o) : 3);

/**
 * 判据是不是变弱了：kind 换成更弱的一种；api 的 path/op/value 被改动使它更宽（eq→exists/gte/lte）；
 * text 的字面量变短或丢了。
 */
function oracleWeakened(before: MachineOracle, after: MachineOracle): string | null {
  if (strength(after) > strength(before)) return `判据从 tier ${strength(before)} 退到 tier ${strength(after)}`;
  if (before.kind === "api" && after.kind === "api") {
    const looser = (b: string, a: string) => b === "eq" && (a === "exists" || a === "gte" || a === "lte" || a === "neq");
    if (looser(before.op, after.op)) return `api 判据从 ${before.op} 放宽成 ${after.op}`;
    if (before.op === after.op && before.value !== undefined && after.value === undefined) return "api 判据丢了 value";
    if (before.path !== after.path && after.path.split(".").length < before.path.split(".").length) return `api 判据路径从 ${before.path} 缩短成 ${after.path}`;
  }
  if (before.kind === "api" && after.kind !== "api") return `判据从 api 换成 ${after.kind}——不再读接口`;
  if ("value" in before && "value" in after && typeof before.value === "string" && typeof after.value === "string") {
    if (after.value.trim().length < before.value.trim().length * 0.67) return `判据字面量从「${before.value}」缩成「${after.value}」`;
  }
  return null;
}

export function classifyDegrade(before: DegradableCase | undefined, after: DegradableCase | undefined): DegradeFinding[] {
  if (before && !after) return [{ kind: "case-removed", detail: `用例 ${before.id} 被删除` }];
  if (!before || !after) return [];
  const out: DegradeFinding[] = [];
  if (before.oracle && !after.oracle) out.push({ kind: "oracle-removed", detail: `用例 ${after.id} 的机器判据被去掉（原为 ${before.oracle.kind}）` });
  else if (before.oracle && after.oracle) {
    const why = oracleWeakened(before.oracle, after.oracle);
    if (why) out.push({ kind: "oracle-weakened", detail: `用例 ${after.id}：${why}` });
  }
  if (before.tier !== undefined && after.tier !== undefined && after.tier > before.tier)
    out.push({ kind: "tier-dropped", detail: `用例 ${after.id} 的 tier 从 ${before.tier} 掉到 ${after.tier}` });
  const be = before.expected ?? "";
  const ae = after.expected ?? "";
  if (be && (ae.trim().length < be.trim().length * 0.67 || literals(be).some((l) => !ae.includes(l))))
    out.push({ kind: "expected-vague", detail: `用例 ${after.id} 的 expected 从「${be.slice(0, 40)}」变成「${ae.slice(0, 40)}」——变短或丢了字面量` });
  return out;
}

export const isDegraded = (before: DegradableCase | undefined, after: DegradableCase | undefined): boolean => classifyDegrade(before, after).length > 0;
