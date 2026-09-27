/**
 * 执行时会发生什么——用例设计阶段就要知道的执行语义。docs/v3/15 阶段 2。
 *
 * 2026-09-25～27 run-03387545 的执行准备里，51 条首轮没过的用例有一大块是同一类原因：
 * 设计时看不到执行器怎么读屏、界面什么时候刷新、收尾靠什么认出自己的资源，
 * 只能靠准备阶段一轮轮试跑撞出来（首轮试跑通过率 50.7%，见 docs/reports/prep-baseline-2026-09-28.md）。
 * 这些规则跟被测产品无关，每条用例都用得上，所以**常驻**在用例契约里（Skill Blocks 的结论：
 * 每轮都要用的内容常驻，按需加载只给部分用得上的）。
 *
 * 单一来源：A 臂 `CASES_STABLE`、宿主单元契约（server/src/workUnits.ts）都从这里取；
 * C 臂 `testpilot-design` 用中文逐条认领（scripts/check-drift.mjs）。
 * 领域中立：这里不许出现任何产品的名字、字段或界面文案（`pnpm check:domain-neutral`）。
 */
export const EXECUTION_SEMANTICS: readonly string[] = [
  // 2026-09-27 C-POS-04-03：点完关闭立刻核对「标签不带数量」失败，两步后同一页面已是空表。
  "The screen needs time to catch up after an action that removes or changes something (cancel, close, delete, save). Do not assert that it is gone on that same step; assert it after the next step, or read a label that stays visible everywhere. Counter-example: \"after clicking the confirm button the list shows no rows\", checked on that step, fails while the list is still refreshing.",
  // 2026-09-26 C-ORD-02-02：总判定读的是另一个标签页里才有的空表文案。
  "An assertion reads the screen as it is after its step: only the tab or panel that is open is visible. To judge something whatever tab is open, use text that stays visible (for example a tab label that carries a count); otherwise switch to that tab first and assert after that step.",
  // 2026-09-27 C-ORD-03-02：拒绝提示在确认后立即出现、几秒就消失，下一步再读已经没了。
  "A transient message (a toast, an inline error that fades) must be asserted on the step that triggers it; one step later it is gone.",
  "A confirmation dialog is its own step: the click that opens it and the click that confirms it are two steps, and nothing else goes in either.",
  // 2026-09-27 J02-03 / ORD-06-02 / ORD-06-03：配方与用例各建各撤，配方写错时留下资源；改成用例自建后都过了。
  "If the case's own steps can create the resource it needs, create it in the steps and declare it in lifecycle. Ask preparation for a state only when it must exist before the first step. A preparation recipe that builds what the steps build anyway doubles the cleanup and leaves the resource behind when either side fails.",
  // 2026-09-27 J01-03：用例最后切到别的标签，收尾认不出自己的资源，留下过一笔。
  "End the case on the screen where its own resources are visible, so cleanup can recognise and undo them. A cleanup check must tell the undone state from the leftover one: a word that appears on the page either way proves nothing.",
  // 2026-09-27 C-ORD-06-02：配方收尾要求「撤销历史」，永远核对不过。
  "An effect the product cannot undo (a history row, a fee, a notification sent) goes in lifecycle.sideEffects, never in cleanup.",
  // 2026-09-27：「保证金弹窗按 Escape 关」这类没核过的界面说法，带偏了准备与改写。
  "Literal interface text in steps and oracles (labels, button names, number formats) comes from the specification or observation material you were given. Do not write a literal you have not seen there; if you must, say in readiness.reason that it is unverified.",
];

/**
 * 判据能力表——**按需**，写数值、跨步骤或不确定该用哪种判据时才读。宿主一侧是
 * `testpilot-design/REFERENCE-oracle.md` 的同名一节；准备节点在「写数值判据」说明里引用。
 */
export const ORACLE_CAPABILITIES = [
  "What each oracle can and cannot decide:",
  "- text / noText: a literal on the screen after the step. Cannot compare two numbers, cannot see another tab.",
  "- count: how many times a literal appears. Use for rows that share a label.",
  "- delta: a number printed right beside a label, before vs after the step. Cannot read table cells whose header is far from the value.",
  "- decimal-equation: arithmetic over readings taken from ONE screen snapshot (formula in RPN, constants allowed, compare eq/gt/gte/lt/lte). Cannot use a reading from an earlier step.",
  "- judge: a model looks at the screen and answers yes/no statements, sampled several times. Unstable; use only for generated content nothing else can decide.",
  "- None of them compares a reading from one step with a reading from a later step, or reads a value from another screen. If the check needs that, say so in readiness.reason instead of forcing a judge.",
].join("\n");
