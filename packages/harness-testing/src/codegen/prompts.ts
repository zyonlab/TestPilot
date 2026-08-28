/**
 * Stage-two prompts. Same split as stage one: the stable half first (it is what the
 * endpoint's prefix cache reuses across every case in a batch), the material last.
 */

export const CODEGEN_STABLE = [
  "You turn ONE text-level test case into runnable Midscene test code.",
  "",
  "The only calls you may use:",
  "  await agent.aiAction('<a short, concrete UI action in natural language>');",
  "  await agent.aiInput('<value>', '<which field>');",
  "  await agent.aiAssert('<the condition to verify>');",
  "",
  "Rules:",
  "- Emit statements only. No imports, no wrapper function, no comments, no markdown fences.",
  "- Every case ends with at least one aiAssert. A case that asserts nothing cannot fail.",
  "  EXCEPT when the material says VERDICT: decided by a program. Then emit the ACTIONS ONLY",
  "  and no aiAssert at all — the verdict is already settled by a machine-checkable oracle",
  "  that runs after your last statement. An aiAssert there is not a second opinion: it runs",
  "  BEFORE the oracle and throws on failure, so a model judging a screenshot can veto a",
  "  verdict a program was going to settle. It also costs a model call on every single run.",
  "- Keep ${env.NAME} and ${secret.NAME} placeholders exactly as they appear. Never write a",
  "  credential, a URL or a magic value into the source. If the case needs a username or a",
  "  password and does not name a placeholder, use ${env.USERNAME} and ${secret.PASSWORD}:",
  "  inventing a value makes the case fail for a reason that has nothing to do with the product.",
  "- Never sleep or wait on a timer. If you must wait, wait for a condition inside an action.",
  "- One action per statement, in the order the case describes. Each aiAction must be ONE",
  "  concrete interaction a person could do in a second: click this, type that, choose the",
  "  other. Never a goal ('navigate to the product list page', 'complete the checkout') and",
  "  never a wait-for-a-page ('wait for the list to load and display the products'): the",
  "  driver plans a goal into actions and gives up when it cannot — the run then fails for",
  "  the way the step was worded, and gets reported as if the product were broken.",
  "- The run already opens the application at its entry point, so never emit a step that",
  "  navigates to it. Start from what is on that first screen.",
  "- PRECONDITIONS are a state, not a comment. The run starts at the application's entry",
  "  point, so anything the case assumes — being on a particular screen, having opened a",
  "  panel — has to be reached: emit the actions that get there BEFORE the case's own steps.",
  "  A case whose first step acts on a screen the run never navigated to does not fail",
  "  because the product is broken; it fails because it was never taken to the product.",
  "- Assert what the case says to assert, in the case's own words. Do not soften it, do not",
  "  broaden it, and do not replace a specific claim with a general one.",
].join("\n");

export function codegenVariable(kase: {
  title: string;
  precondition?: string[];
  steps: string[];
  expected: string;
  /**
   * 这条用例的判决由谁下。
   *
   * 有机器判据时（38/40 的用例都有），判决在**最后一条语句之后**由程序求值，
   * 而生成的代码此前一无所知——于是它照样写 `aiAssert`，那句话作为**步骤**执行，
   * 模型判它为假就抛异常、用例失败，**机器判据根本没机会开口**。
   * 等于把模型插在程序前面，让它可以否决一个程序本该决定的结论；每次执行还多烧一次调用
   * （实测一批 40 条用例里有 57 次 aiAssert）。
   */
  oracle?: unknown;
}): string {
  return [
    `CASE: ${kase.title}`,
    ...(kase.precondition?.length ? ["PRECONDITIONS:", ...kase.precondition.map((p) => `- ${p}`)] : []),
    "STEPS:",
    ...kase.steps.map((s, i) => `${i + 1}. ${s}`),
    `EXPECTED: ${kase.expected}`,
    ...(kase.oracle
      ? ["VERDICT: decided by a program — emit the actions only, no aiAssert."]
      : []),
  ].join("\n");
}

export const REPAIR_STABLE = [
  "A generated test case failed when it was run. Fix the code.",
  "",
  "The only calls you may use:",
  "  await agent.aiAction('<action>');  await agent.aiInput('<value>', '<field>');  await agent.aiAssert('<condition>');",
  "",
  "What you MAY change:",
  "- the wording of an action, so the model driving the UI can find its target",
  "- the order of actions, or an extra action the flow needs",
  "- waiting for a condition inside an action, when the page needs time",
  "",
  "What you MUST NOT change:",
  "- the assertion's meaning. Do not weaken it, do not broaden it, do not delete it.",
  "  If the product genuinely does not do what the case asserts, say so instead of fixing:",
  '  reply exactly {"verdict":"product-defect","reason":"..."} and change nothing.',
  "- the case's purpose. Do not replace it with an easier case.",
  "",
  "Emit statements only, no fences, no prose.",
].join("\n");

export function repairVariable(input: {
  title: string;
  code: string;
  failure: string;
  failKind?: string;
  round: number;
}): string {
  return [
    `CASE: ${input.title}`,
    `ROUND: ${input.round}`,
    `FAILURE (${input.failKind ?? "unknown"}): ${input.failure}`,
    "CURRENT CODE:",
    input.code,
  ].join("\n");
}
