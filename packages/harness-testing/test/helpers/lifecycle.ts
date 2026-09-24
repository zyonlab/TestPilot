/**
 * 门禁把缺 lifecycle 记成 warn 之后（2026-09-24），测别的规则的夹具也得带一份合格的只读 lifecycle，
 * 否则每条用例都被 lifecycle 点到，别的规则的分数就测不出来了。
 */
export function readOnly<T extends { precondition?: string[]; sourceRefs?: string[] }>(c: T): T {
  const sourceRefs = c.sourceRefs?.length ? c.sourceRefs : ["spec#1"];
  const statements = c.precondition?.length ? c.precondition : ["页面已打开"];
  return { ...c, sourceRefs, lifecycle: { version: 2, mode: "read-only", rationale: "fixture: read-only", sourceRefs: [sourceRefs[0]!], supports: ["$expected"],
    baseline: statements.map(s => ({ statement: s, checks: [{ kind: "screen", statement: s, oracle: { kind: "text", value: "x" } }] })),
    session: "unchanged", resources: [], settings: [], cleanup: [], sideEffects: [] } } as T;
}
