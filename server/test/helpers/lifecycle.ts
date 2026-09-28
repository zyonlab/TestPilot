/**
 * 门禁把缺 lifecycle 记成 warn（2026-09-24）之后，走到 gate/finalize 的夹具用例都要带一份合格的只读 lifecycle。
 * sourceRef 取用例自己的第一条来源；precondition 逐条进 baseline（校验器要求逐字覆盖）。
 */
export const readOnlyLifecycle = (sourceRef: string, precondition: string[] = [], onScreen = "x") => ({
  version: 2 as const, mode: "read-only" as const, rationale: "fixture: read-only", sourceRefs: [sourceRef], supports: ["$expected"],
  baseline: (precondition.length ? precondition : ["page is open"]).map(s => ({ statement: s, checks: [{ kind: "screen" as const, statement: s, oracle: { kind: "text" as const, value: onScreen } }] })),
  session: "unchanged" as const, resources: [], settings: [], cleanup: [], sideEffects: [],
});
