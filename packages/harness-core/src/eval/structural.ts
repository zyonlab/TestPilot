/**
 * 结构覆盖率：分母来自产品本身，不是来自人写的清单。
 *
 * 语义覆盖（`coverage.ts`）问的是「测的是不是**该测的东西**」，分母是人手抽的黄金清单。
 * 那个数有它不可替代的意义，但它永远回答不了「**够不够**」——因为清单本身有多全，
 * 没有人说得清。
 *
 * 状态转移图给出另一个分母：这个产品一共有 N 个状态、M 条转移，你的用例走到了几个、
 * 覆盖了几条。这是模型基测试的标准口径（状态覆盖 / 转移覆盖即 0-switch / 相邻转移对
 * 即 1-switch，源头是 Chow 1978 的 W-method）。
 *
 * **但它不是北极星。** 同一份实证研究（Liu, Yang, Zhang, Xie 2026）的结论之一是
 * *code coverage is not strongly correlated with failure-revealing ability* ——
 * 覆盖高不等于抓得到缺陷。所以它和语义覆盖、缺陷检出三个数并排出现，谁也不取代谁。
 */

export interface StructuralModel {
  states: Array<{ id: string }>;
  transitions: Array<{ from: string; to?: string; ok: boolean; action: { kind: string; target: string } }>;
}

/** 一条用例声称自己走了哪些转移。空的表示它没说——那本身是一个要报出来的数。 */
export interface CoveringCase {
  id?: string;
  title?: string;
  /** `from->to` 形式的转移 id。 */
  covers?: string[];
}

export interface StructuralCoverage {
  /** 走到过的状态 ÷ 图上的状态。 */
  stateCoverage: number;
  /** 覆盖到的转移 ÷ 图上**走得通**的转移。这就是 0-switch 覆盖。 */
  transitionCoverage: number;
  /** 相邻转移对：走完一条边紧接着走另一条。1-switch 覆盖。 */
  pairCoverage: number;
  /** 没有任何用例覆盖的转移——**它们是这批用例的洞，而且是查得出来的洞**。 */
  uncovered: string[];
  /** 没有声称覆盖任何转移的用例数。声称不了，说明它没在验证一次变化。 */
  silent: number;
  totals: { states: number; transitions: number; pairs: number; cases: number };
}

export const transitionId = (t: { from: string; to?: string }): string => `${t.from}->${t.to ?? "✗"}`;

export function scoreStructural(model: StructuralModel, cases: CoveringCase[]): StructuralCoverage {
  // 只算走得通的边：走不通的那些记在图里是为了说明「这条路走不过去」，
  // 拿它们当分母会让覆盖率永远到不了 1，而那个缺口说明不了用例的任何事。
  const walkable = model.transitions.filter((t) => t.ok && t.to);
  const allT = new Set(walkable.map(transitionId));

  const pairs = new Set<string>();
  for (const a of walkable)
    for (const b of walkable) if (a.to === b.from) pairs.add(`${transitionId(a)}|${transitionId(b)}`);

  const covered = new Set<string>();
  let silent = 0;
  for (const c of cases) {
    const list = (c.covers ?? []).filter((x) => allT.has(x));
    if (!list.length) silent += 1;
    for (const x of list) covered.add(x);
  }

  const coveredStates = new Set<string>();
  for (const id of covered) {
    const [from, to] = id.split("->");
    coveredStates.add(from);
    coveredStates.add(to);
  }

  const coveredPairs = [...pairs].filter((p) => {
    const [a, b] = p.split("|");
    return covered.has(a) && covered.has(b);
  });

  const ratio = (n: number, d: number): number => (d ? Number((n / d).toFixed(3)) : 0);
  return {
    stateCoverage: ratio(coveredStates.size, model.states.length),
    transitionCoverage: ratio(covered.size, allT.size),
    pairCoverage: ratio(coveredPairs.length, pairs.size),
    uncovered: [...allT].filter((t) => !covered.has(t)).sort(),
    silent,
    totals: { states: model.states.length, transitions: allT.size, pairs: pairs.size, cases: cases.length },
  };
}
