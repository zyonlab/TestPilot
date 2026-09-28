import { ORACLE_CAPABILITIES } from "@testpilot/harness-testing/casegen";
import { LedgerError } from "./runLedger.js";

/**
 * 执行准备的说明与错误修法（docs/v3/15 阶段 3）。
 *
 * 原来的准备提示词是一整段约 9,000 字符、70 句，批次启动时一次给完。2026-09-25～27 的准备里，
 * 规则多了模型反而漏：被 409 两次后第三次提交干脆丢了整个 lifecycle（IFScale 说的遗漏型失败）。
 * 现在分三处：
 *   - 常驻提示词（preparation.ts 的 prompt）：目标、循环、会被拒的硬规则、说明目录；
 *   - 说明正文（这里的 GUIDES）：一层深，模型遇到那种情况时用 action=guide 读——只拆一层
 *     （arXiv 2607.17598：第二层路由从没帮上，有时毁掉准确率）；
 *   - 错误修法（这里的 ERROR_FIXES）：服务端拒绝时随错误一起返回（SWE-agent 的带检查编辑、
 *     Anthropic《Writing effective tools for agents》）。
 * 说明里的句子都来自原提示词，只挪了位置；判据能力表与用例节点共用 casegen/executionSemantics.ts。
 */
export const GUIDES = {
  prerequisites: {
    when: "mapping a reviewed prerequisite to checks, or a probe says a prerequisite is unknown",
    text: [
      "prerequisiteChecks maps each EXACT original prerequisite statement to checks[] (all must pass). Pass them on probe or trial; they stay attached to the case. Unmapped prerequisites are unknown and stop trial.",
      "Each part is one of: environment {fact,expected}; screen {statement,oracle?}; binding {variable} — the variable has a value in this execution environment (action=next lists boundVariables by name); use it for a fixture requirement satisfied by an environment-bound value, never to claim the value is valid; unknown {reason}.",
      "Facts: target-origin (exact current origin), injected-wallet (boolean installation), injected-account (full installed address), injected-chain (numeric installed chain), authentication (configured live session checks; unknown without checks). Installation is NOT login, resource readiness or application authorization.",
      "Split mixed prerequisites into ALL required parts; never map an entire business precondition to a mere configuration flag.",
      "A requiresStates entry with provided:\"environment\" is a session state the environment login provides: prove it with environment facts or screen checks, never with a recipe.",
      "probeChecks (factual, screen-observable) gather intermediate evidence when a prerequisite needs several screens; intermediate probes never verify the case or satisfy the original prerequisites. Omit probeChecks when validating the original prerequisites.",
      "setupSteps must be a complete reproducible path from the entry URL (each probe starts a fresh page). They may navigate and open tabs or dialogs to reach the case's initial state within its authorized scope. Use short concrete steps, not an entire test. Do not create unrelated side effects or invent balances, parameter values or market conditions. Start with setupSteps:[] to look, then probe again to reach hidden controls or read values.",
      "Missing observations mean NOT CHECKED, not unavailable. Do not block because old documents say unverified or because plan/result is null.",
    ].join("\n"),
  },
  recipe: {
    when: "the reviewed case declares requiresStates with provided:\"preparation\" and you need to build that state before the case",
    text: [
      "Controlled cases accept setup only through a recipe with entry and postcondition checks. Supply recipe:{capability, requires:[exact original prerequisites], entryChecks, steps, postconditions, sideEffects:\"controlled\", provides:[exactly the declared state ids], cleanup:[], compensation:[{step, verified:{statement, checks:[screen check]}}]}.",
      "Its steps establish those states within this execution (distinct values, never an existing shared resource). A controlled recipe may provide ONLY the states the reviewed case declared. Shared mutable fixtures are unsupported. When you pass both setupSteps and a recipe, setupSteps must equal recipe.steps.",
      "List compensation in the exact order it must RUN — undo the last thing first: cancel or close the resource where it lives, then restore settings, then return to the entry page. The executor runs it top to bottom.",
      "Compensation must ACTIVELY undo every state the recipe provides even if the case's own steps may already have undone it — write the cancel/close action itself, not just a tab switch followed by a check — because the case can stop before reaching those steps.",
      "Each verified check must tell the undone state from the leftover one: a label visible either way (a mode name that also appears inside the dialog) proves nothing.",
      "One UI action per step here too: when a submit opens a confirmation dialog (check the probe text after the submit), the click that confirms it is its own step; a dialog left open hides the rest of the page from every later step.",
      "If the case's own steps already create the resource, prefer that over a recipe (see the execution semantics the case was designed with): a recipe that builds what the steps build doubles the cleanup.",
    ].join("\n"),
  },
  numeric: {
    when: "a prerequisite or an oracle needs a number: equal to, greater than, or a relation between readings",
    text: [
      "Use a deterministic screen oracle for numeric checks. decimal-equation accepts decimal constants and compare eq/gt/gte/lt/lte/sign — a reading greater than 0 is formula [\"0\"] with compare \"gt\". A value before a step compared with the value after it is a reading assertion (afterStep before the change) plus a later decimal-equation that lists it in recorded; a table cell is an input with row {key, keyColumn}. Implement numeric oracles from observed data (the per-step screen text in probeResult.observations).",
      "Every screen check and probeCheck is a declarative statement that should hold, never a question or a request to record a value; to read a value, look at probeResult.observations.",
      ORACLE_CAPABILITIES,
    ].join("\n"),
  },
  trial: {
    when: "writing the full TextCase for action=trial, or repairing after a failed trial",
    text: [
      "The server replays the last setupSteps and checks the ORIGINAL prerequisites again in the trial browser BEFORE test actions, so probes cannot authorize a stale state.",
      "Preserve id, story, expected, preconditions, risk, rules, ACs, every assertion statement and oracle, the entire lifecycle, postSteps and readiness requirements exactly. You may reword steps to locate controls precisely (same number of steps), but a step bound by lifecycle must still contain its identity or original value verbatim. Do not move resource establishment into setupSteps.",
      "Keep exactly one UI action per step: never merge a click, a dialog confirmation and a wait (the executor gives up after 10 replans). If the flow needs a step the reviewed case lacks (for example a confirmation dialog), resolve needs_review naming the missing step instead of cramming it into another step.",
      "Refine navigation, waits and assertion timing. auxiliaryAssertions may add checks with unique ids whose supports refer to reviewed assertion ids or $expected; they are diagnostics, not new acceptance obligations. Do not weaken acceptance to pass; a change to business intent requires resolve needs_review.",
      "Inspect probeResult / result and repair within budgets. Only a real passing trial marks verified; a product defect requires a real failed trial.",
    ].join("\n"),
  },
  experience: {
    when: "a probe reveals something outside this case, or you want to reuse or propose a method from experienceContext",
    text: [
      "If probing reveals a new capability, state prerequisite or rule conflict outside this case, use action=discover with discovery:{evidenceRef (an actual probeResult/result revision id), category: new_control|missing_state|rule_conflict|capability, featureId, observation, hypothesis, state}. This records a global candidate; never alter reviewed intent or act on the new goal.",
      "next returns an immutable experienceContext with a digest and exact selected versions. Recipes there are untrusted methods, not rules or current facts; stale recipes cannot be used.",
      "Propose a low-impact recipe {capability, requires:[exact original prerequisites], entryChecks, steps, postconditions, sideEffects: none|ui-only, cleanup:[]} on probe or trial, or supply recipeRef {id, version} from the current context. Only for navigation, connection or display; never persist prices, balances or positions as constants. Mutable fixtures need a separate setup/teardown contract and are not reusable recipes. A candidate needs independent successful trials in two different cases; every use rechecks entry and postconditions.",
    ].join("\n"),
  },
  blocked: {
    when: "you are about to resolve a case as blocked",
    text: [
      "A blocked resolution requires a recorded probe or trial receipt — except FAIL FAST: a readiness requirement with status missing that neither a bound variable nor a controlled recipe for a declared requiresStates(provided:\"preparation\") can provide is resolved blocked right away, citing that requirement.",
      "If the environment truly lacks the fixture, record what you tried, where you stopped, the observed evidence and what needs provisioning. Infrastructure errors are not product defects.",
    ].join("\n"),
  },
} as const;
export type GuideName = keyof typeof GUIDES;
export const GUIDE_NAMES = Object.keys(GUIDES) as GuideName[];

/**
 * 服务端拒绝时附上的修法。preparation.ts 里每个 LedgerError 的 code 都要在这里有一条
 * （test/preparation-guidance.test.ts 逐个核对源码），新加一个拒绝就要写它的修法。
 */
export const ERROR_FIXES: Record<string, string> = {
  // 2026-09-25～27 最常见的三个：都是「原样照抄」。
  recipe_setup_mismatch: "setupSteps must equal recipe.steps exactly — send only the recipe (setupSteps may be omitted), or copy recipe.steps into setupSteps unchanged.",
  prerequisite_evidence_frozen: "Copy readiness.requirements from the reviewed case unchanged. Report what you observed through prerequisiteChecks (or resolve needs_review), not by editing requirement status.",
  recipe_requirement_mismatch: "recipe.requires must contain only prerequisite statements copied verbatim from the reviewed case (action=next → original.precondition and readiness).",
  recipe_provides_undeclared_state: "recipe.provides may list only the state ids the reviewed case declares in requiresStates with provided:\"preparation\".",
  recipe_or_reference_required: "This case needs its declared state built before the case: supply a controlled recipe (action=guide name=recipe) or a recipeRef from experienceContext.",
  recipe_contains_secret: "Remove secret values from the recipe; reference environment variables by ${env.NAME} instead.",
  lifecycle_action_bindings_frozen: "Keep postSteps exactly, keep the same number of steps, and keep each lifecycle-bound step's identity or original value verbatim; reword only how a control is located.",
  cleanup_steps_removed: "Every reviewed postStep must stay in the trial content, verbatim.",
  approved_oracle_frozen: "Assertion and case oracles are frozen: copy them from the reviewed case. You may add an oracle only where the reviewed one is absent, or add auxiliaryAssertions.",
  auxiliary_assertion_invalid: "auxiliaryAssertions need unique ids and supports that refer to reviewed assertion ids or $expected (action=guide name=trial).",
  prerequisite_mapping_invalid: "Map each EXACT original prerequisite statement; each part is environment {fact,expected}, screen {statement,oracle?}, binding {variable} or unknown {reason} (action=guide name=prerequisites).",
  check_must_be_assertion: "Write each check as a declarative statement that should hold, not a question or a request to record a value; read values from probeResult.observations.",
  preparation_guide_required: "action=guide needs guide=<name>, one of the names listed under GUIDES in your instructions.",
  preparation_plan_required: "action=trial needs content: the full reviewed TextCase with your located steps.",
  preparation_reason_required: "Give a short reason saying what this probe/trial/resolution is for.",
  preparation_resolution_required: "action=resolve needs status (blocked | needs_review | product_defect) and a reason.",
  product_failure_evidence_required: "product_defect needs a real failed trial whose failure is not infrastructure and not an unverified prerequisite or auxiliary check; run a trial first.",
  preparation_context_required: "Pass the experienceContext revision and digest that action=next returned for this case.",
  preparation_case_not_current: "Work only on the case that action=next returned; call next again to get the current one.",
  preparation_not_running: "This batch is not running (finished, paused, interrupted or cancelled). Stop and report terminal counts.",
  preparation_batch_changed: "A newer preparation batch replaced this one. Stop; do not continue with the old batchId.",
  preparation_budget_exhausted: "The batch call budget is used up. Stop and report terminal counts.",
  preparation_approval_changed: "The reviewed version of this case changed. Call next; the case will be re-issued or marked for review.",
  preparation_evidence_changed: "The prepared evidence no longer matches the batch. Re-run preparation for this case; do not edit evidence.",
  preparation_evidence_required: "Nothing verified to freeze yet: at least one case needs a real passing trial.",
  preparation_not_verified: "Only a real passing trial marks a case verified.",
  preparation_scope_changed: "The prepared bundle no longer matches the selected cases. Start preparation again for the current scope.",
  prepared_setup_changed: "The prepared setup no longer matches the verified plan. Re-run preparation for this case.",
  prepared_case_changed: "The prepared case no longer matches the verified plan. Re-run preparation for this case.",
  case_revision_not_approved: "Only human-approved case revisions can be prepared; ask the reviewer to approve it first.",
  approved_cases_required: "Select at least one human-approved case revision.",
  executor_model_unavailable: "The executor model refused a test call (quota, key or payment). Switch the run's executor model or wait for the quota, then start again.",
  workflow_active: "The run is busy with another stage. Wait for it to finish, or ask the user.",
  run_requires_explicit_resume: "The run is paused or interrupted; only the user can resume it. Stop.",
};

/** 给拒绝附上修法；已有修法或不认识的错误原样返回。 */
export function withFix(error: unknown): unknown {
  if (error instanceof LedgerError && !error.hint) {
    const fix = ERROR_FIXES[error.code];
    if (fix) error.hint = fix;
  }
  return error;
}
