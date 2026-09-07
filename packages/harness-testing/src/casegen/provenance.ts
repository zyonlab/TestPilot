/**
 * 出处核对：一条用例声称的 `sourceRefs`，是不是**这次运行真正取到过**的段。
 *
 * 规则只有这一处。写盘 hook（`plugins/testpilot/hooks/validate-cases.mjs`）与 A 臂的
 * `design.cases` 节点都 import 它——抄一份进 hook，两臂就不再只差一件事。
 *
 * 借的是 commerce-agents 的 provenance gate（`shopping_agent/gates.py`）：写操作只接受
 * 本会话工具返回过的 id，对不上的 id **丢掉并报出来**，一条什么都不剩的组件拒绝渲染。
 * 这里对应的三种结果：
 *
 * - `unreferenced`：一条 ref 都没写的用例。它的断言查不到任何出处。
 * - `unknown`：写了 ref，但那个 id 不在本次取到的段里。要么编的，要么是别的材料的。
 * - 都没有：出处成立。
 *
 * 它**不**判断引对了没有——「这段规格是否真支持这条断言」是语义问题，归 judge；
 * 这里只判「这个 id 是不是真的存在且被取过」，那是事实问题，一个集合查找就够。
 */

export interface ProvenanceReport {
  /** 一条 `sourceRefs` 都没有的用例 id。 */
  unreferenced: string[];
  /** 写了但对不上的：哪条用例、哪几个 id。 */
  unknown: Array<{ caseId: string; refs: string[] }>;
  /** 核对时手里有多少个已知 id。0 说明根本没有可核对的基底——那本身是一条发现。 */
  known: number;
  /** 有出处的用例数。 */
  anchored: number;
}

export function checkProvenance(
  cases: ReadonlyArray<{ id: string; sourceRefs?: ReadonlyArray<string> }>,
  known: Iterable<string>,
): ProvenanceReport {
  const set = new Set(known);
  const report: ProvenanceReport = { unreferenced: [], unknown: [], known: set.size, anchored: 0 };
  for (const c of cases) {
    const refs = c.sourceRefs ?? [];
    if (!refs.length) {
      report.unreferenced.push(c.id);
      continue;
    }
    const bad = refs.filter((r) => !set.has(r));
    if (bad.length) report.unknown.push({ caseId: c.id, refs: bad });
    else report.anchored += 1;
  }
  return report;
}

/** 一句能进 `reason` 的话。列到 `max` 条就停——reason 是要进模型上下文的。 */
export function describeProvenance(report: ProvenanceReport, max = 6): string {
  const parts: string[] = [];
  if (report.unreferenced.length)
    parts.push(
      `${report.unreferenced.length} 条用例没有 sourceRefs（${report.unreferenced.slice(0, max).join(", ")}${
        report.unreferenced.length > max ? " …" : ""
      }）`,
    );
  if (report.unknown.length)
    parts.push(
      `${report.unknown.length} 条用例引用了本次没取到的段（${report.unknown
        .slice(0, max)
        .map((u) => `${u.caseId}: ${u.refs.join(" ")}`)
        .join("；")}${report.unknown.length > max ? " …" : ""}）`,
    );
  return parts.join("；");
}
