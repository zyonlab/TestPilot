import { runGate, type TextCase } from '@testpilot/harness-testing/casegen';
import { lifecycleIssues } from '@testpilot/harness-testing';
import { referencedKeys } from '@testpilot/harness-core';
import type { ProductRulePack } from '@testpilot/harness-testing/domain';

/**
 * 交给准备器之前，服务端就能确定「准备不出来」的用例。
 *
 * 2026-09-25 的三批准备里，11 条用例每条花 1–3 次探查（每次先走一遍登录）才发现：引用的变量没绑定、
 * 会话状态被写成「由准备提供」、持久设置没登记、一步塞了几个动作——这些对着用例正文与环境就能判，
 * 用不着开浏览器。判下来的直接 blocked，理由写清缺什么；人改了用例、重新批准，下一批自然再准入。
 *
 * 只挡**确定**的：规则包与环境里没有的数据不猜，判不了的照旧交给准备器去看。
 */
/** 新契约下必须修的门禁规则。info 级的（方法对不上、tier 等）不挡。 */
const BLOCKING_RULES = new Set(['setting-undeclared', 'step-compound']);

export function admissionIssues(c: TextCase, ctx: { vars: Record<string, unknown>; pack?: ProductRulePack }): string[] {
  const issues: string[] = [];
  if (c.readiness?.execution === 'not-executable') issues.push(`not_executable: ${c.readiness.reason || 'reviewed readiness says this case cannot run here'}`);
  // 用例里所有会被执行或判决的文字：一处引用了没绑定的变量，执行器在那一步就会停。
  const texts = [
    ...c.steps, ...c.postSteps, ...(c.precondition ?? []), c.expected,
    ...(c.assertions ?? []).map((a) => JSON.stringify(a)),
    JSON.stringify(c.oracle ?? null), JSON.stringify(c.lifecycle ?? null),
  ];
  const unbound = [...new Set(texts.flatMap((t) => referencedKeys(t).env))].filter((k) => k !== 'TP_LIFECYCLE_ID' && !(k in ctx.vars));
  if (unbound.length) issues.push(`unbound_variables: ${unbound.map((k) => 'env.' + k).join(', ')} — bind them in the execution environment or change the case`);
  if (c.lifecycle) for (const i of lifecycleIssues(c as never)) issues.push(`lifecycle: ${i}`);
  const gate = runGate({ stories: [], cases: [c], flows: [] } as never, {
    actionVocabulary: ctx.pack?.actionVocabulary, volatileReadings: ctx.pack?.volatileReadings, persistedSettings: ctx.pack?.persistedSettings,
  });
  for (const f of gate.findings) if (f.caseId === c.id && f.severity === 'warn' && BLOCKING_RULES.has(f.rule)) issues.push(`${f.rule}: ${f.message}`);
  return [...new Set(issues)];
}

/**
 * 会话类状态（规则包 states 里 kind 为 session，比如「钱包已连接」）由执行环境的登录提供。
 * 旧用例把它写成 provided:"preparation"，准备就要一个根本写不出来的配方（2026-09-25：ACC-03-02、J02-01
 * `required_state_not_prepared:wallet.connected`）。不管用例怎么写，这类状态都不要求配方。
 */
export function statesNeedingRecipe(c: TextCase, pack?: ProductRulePack): string[] {
  const session = new Set((pack?.states ?? []).filter((s) => s.kind === 'session').map((s) => s.id));
  return (c.requiresStates ?? []).filter((r) => r.provided === 'preparation' && !session.has(r.state)).map((r) => r.state);
}

/** 复核页用：每条已审核用例在当前环境与契约下会不会被准备前裁决挡住。算不出来（缺环境等）就不标，免得误报。 */
export async function reviewAdmission<T extends { caseId: string; content: unknown }>(runId: string, projectId: string, cases: T[]): Promise<Array<T & { admission?: string[] }>> {
  const [{ runLedger }, { resolveEnvironment }, { boundRulePack }] = await Promise.all([import('./runService.js'), import('./db.js'), import('./rulePacks.js')]);
  try {
    const detail = runLedger().getRun(runId, projectId).detail as { target?: { envRef?: string } } | undefined;
    const env = resolveEnvironment(projectId, detail?.target?.envRef), pack = boundRulePack(runId, projectId);
    return cases.map((c) => { const issues = admissionIssues(c.content as TextCase, { vars: env?.vars ?? {}, pack }); return issues.length ? { ...c, admission: issues } : c; });
  } catch { return cases; }
}
