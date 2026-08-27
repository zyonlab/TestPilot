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
  "- Keep ${env.NAME} and ${secret.NAME} placeholders exactly as they appear. Never write a",
  "  credential, a URL or a magic value into the source. If the case needs a username or a",
  "  password and does not name a placeholder, use ${env.USERNAME} and ${secret.PASSWORD}:",
  "  inventing a value makes the case fail for a reason that has nothing to do with the product.",
  "- Never sleep or wait on a timer. If you must wait, wait for a condition inside an action.",
  "- One action per statement, in the order the case describes.",
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
}): string {
  return [
    `CASE: ${kase.title}`,
    ...(kase.precondition?.length ? ["PRECONDITIONS:", ...kase.precondition.map((p) => `- ${p}`)] : []),
    "STEPS:",
    ...kase.steps.map((s, i) => `${i + 1}. ${s}`),
    `EXPECTED: ${kase.expected}`,
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
