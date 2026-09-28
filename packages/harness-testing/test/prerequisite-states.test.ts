import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateRulePack, rulePackHash } from '../src/domain/index.js';
import { businessTransitionIssues } from '../src/casegen/planningContract.js';
import { runGate } from '../src/casegen/gate.js';
import { executionBlockers } from '../src/casegen/readiness.js';
import { SetupRecipeSchema } from '../src/exec/preparationChecks.js';
import { readOnly } from './helpers/lifecycle.js';

/**
 * 2026-09-24：前提状态从规则包 → 故事 → 用例 → 执行准备一路可算。
 * 「平仓要先有持仓」这类链原先只在自由文本里，传没传到用例、准备有没有提供，都没人查。
 */
const pack = JSON.parse(readFileSync(new URL('./fixtures/perp-lab-rules.json', import.meta.url), 'utf8'));
const transition = (over: Record<string, unknown> = {}) => ({ id: 'T-close', featureId: pack.features[0].id, name: 'close', claimType: 'normative', sourceRefs: [pack.sources[0].id], preconditions: ['an open holding exists'], action: 'close it', outcome: 'holding gone', failureModes: ['nothing to close'], preparation: 'open one first', ...over });

describe('rule pack states', () => {
  it('validates state references and leaves old pack hashes untouched', () => {
    const before = validateRulePack(structuredClone(pack));
    expect(before.ok).toBe(true);
    const withStates = validateRulePack({ ...structuredClone(pack), states: [{ id: 'holding.open', name: 'open holding', kind: 'resource', identity: 'slot' }], businessTransitions: [transition({ requiresStates: ['holding.open'] })] });
    expect(withStates.ok, JSON.stringify(withStates)).toBe(true);
    const dangling = validateRulePack({ ...structuredClone(pack), businessTransitions: [transition({ requiresStates: ['nope'] })] });
    expect(dangling.ok).toBe(false);
    // 没写 states 的旧规则包解析后也不多出这个键——哈希里没有它，旧运行绑定的规则包哈希不变。
    if (before.ok) { expect('states' in before.pack).toBe(false); expect(rulePackHash(before.pack)).toMatch(/^[0-9a-f]{64}$/); }
  });
});

describe('transition coverage across stories', () => {
  const t = transition() as never;
  const story = (id: string, success: number[], failure: number[]) => ({ id, title: id, acceptance: ['ok result', 'rejected'], featureRefs: [pack.features[0].id], businessTransitions: [{ transitionId: 'T-close', preconditions: ['an open holding exists'], acceptanceIndexes: success, failureAcceptanceIndexes: failure }] });
  it('a success-only story and a failure-only story together cover the transition', () => {
    expect(businessTransitionIssues([story('S1', [0], []), story('S2', [], [1])] as never, [t])).toEqual([]);
  });
  it('one side alone leaves the transition uncovered', () => {
    expect(businessTransitionIssues([story('S1', [0], [])] as never, [t]).map(i => i.code)).toContain('business_transition_uncovered');
  });
});

describe('gate and readiness', () => {
  const bundle = (requiresStates?: Array<{ state: string; provided: 'steps' | 'preparation' | 'environment' }>, acRefs = ['S1/AC-1']) => ({
    stories: [{ id: 'S1', title: 'close', acceptance: ['When I close it, it is gone', 'When none exists, the close control is absent'], businessTransitions: [{ transitionId: 'T-close', preconditions: ['p'], acceptanceIndexes: [0], failureAcceptanceIndexes: [1] }] }],
    cases: [readOnly({ id: 'C1', storyId: 'S1', title: 'close', designMethod: 'state-transition', steps: ['Click Close'], postSteps: [], expected: 'gone', tier: 3, key: 'k', covers: [], sourceRefs: ['spec#1'], acRefs, ...(requiresStates ? { requiresStates } : {}) })],
    flows: [],
  }) as never;
  const opts = { businessTransitions: [{ id: 'T-close', requiresStates: ['holding.open'] }] };
  it('a success-path case that does not declare the required state is flagged with how to fix it', () => {
    const f = runGate(bundle(), opts).findings.find(x => x.rule === 'requires-state');
    expect(f).toMatchObject({ severity: 'warn', caseId: 'C1' });
    expect(f!.message).toMatch(/provided:"steps"\|"preparation"/);
  });
  it('declaring it clears the finding; a failure-path case need not declare it', () => {
    expect(runGate(bundle([{ state: 'holding.open', provided: 'preparation' }]), opts).findings.some(x => x.rule === 'requires-state')).toBe(false);
    expect(runGate(bundle(undefined, ['S1/AC-2']), opts).findings.some(x => x.rule === 'requires-state')).toBe(false);
  });
  it('a state to be provided by preparation blocks execution admission until prepared', () => {
    const c = (bundle([{ state: 'holding.open', provided: 'preparation' }]) as { cases: never[] }).cases[0];
    expect(executionBlockers(c)).toContain('requires_state:holding.open');
  });
  it('a session state the environment provides needs no recipe and does not block admission', () => {
    const c = (bundle([{ state: 'holding.open', provided: 'environment' }]) as { cases: never[] }).cases[0];
    expect(executionBlockers(c).some((b: string) => b.startsWith('requires_state'))).toBe(false);
    expect(runGate(bundle([{ state: 'holding.open', provided: 'environment' }]), opts).findings.some(x => x.rule === 'requires-state')).toBe(false);
  });
});

describe('controlled recipes', () => {
  const check = { statement: 'holding row shown', checks: [{ kind: 'screen' as const, statement: 'row', oracle: { kind: 'text' as const, value: 'row' } }] };
  const base = { capability: 'holding.open', requires: ['an open holding exists'], entryChecks: [check], steps: ['Open a holding'], postconditions: [check], cleanup: [] };
  it('must declare what it provides and how it is undone on screen', () => {
    expect(SetupRecipeSchema.safeParse({ ...base, sideEffects: 'controlled' }).success).toBe(false);
    expect(SetupRecipeSchema.safeParse({ ...base, sideEffects: 'controlled', provides: ['holding.open'], compensation: [{ step: 'Close it', verified: check }] }).success).toBe(true);
  });
  it('a ui-only recipe cannot smuggle state or compensation', () => {
    expect(SetupRecipeSchema.safeParse({ ...base, sideEffects: 'ui-only', provides: ['holding.open'] }).success).toBe(false);
    expect(SetupRecipeSchema.safeParse({ ...base, sideEffects: 'ui-only' }).success).toBe(true);
  });
});

describe('persisted settings', () => {
  const kase = (steps: string[], settings: unknown[] = []) => {
    const c = readOnly({ id: 'C1', storyId: 'S1', title: 'switch mode', designMethod: 'state-transition', steps, postSteps: [], expected: 'Price field shown', tier: 3, key: 'k', covers: [], sourceRefs: ['spec#1'], acRefs: ['S1/AC-1'] }) as unknown as { lifecycle: Record<string, unknown> };
    return { stories: [{ id: 'S1', title: 'mode', acceptance: ['a'] }], cases: [{ ...c, lifecycle: { ...c.lifecycle, settings } }], flows: [] } as never;
  };
  const opts = { persistedSettings: ['^Click (the )?Advanced tab'] };
  it('a step that changes a remembered choice must be declared as a setting', () => {
    const f = runGate(kase(['Open the panel', 'Click the Advanced tab']), opts).findings.find(x => x.rule === 'setting-undeclared');
    expect(f).toMatchObject({ severity: 'warn', caseId: 'C1', args: { steps: '2' } });
    const declared = [{ id: 'mode', sourceRef: 'spec#1', name: 'mode', original: 'Basic', changedAfterStep: 2, observed: { statement: 'Basic', checks: [] } }];
    expect(runGate(kase(['Open the panel', 'Click the Advanced tab'], declared), opts).findings.some(x => x.rule === 'setting-undeclared')).toBe(false);
  });
  it('a setting committed by a later confirm step covers the selecting step', () => {
    const declared = [{ id: 'mode', sourceRef: 'spec#1', name: 'mode', original: 'Basic', changedAfterStep: 3, observed: { statement: 'Basic', checks: [] } }];
    expect(runGate(kase(['Open the panel', 'Click the Advanced tab', 'Click Confirm'], declared), opts).findings.some(x => x.rule === 'setting-undeclared')).toBe(false);
  });
  it('without rule pack data there is no such rule', () => {
    expect(runGate(kase(['Click the Advanced tab'])).findings.some(x => x.rule === 'setting-undeclared')).toBe(false);
  });
});

describe('one UI action per step', () => {
  const kase = (steps: string[], postSteps: string[] = []) => ({ stories: [{ id: 'S1', title: 's', acceptance: ['a'] }], cases: [readOnly({ id: 'C1', storyId: 'S1', title: 't', designMethod: 'equivalence', steps, postSteps, expected: 'Price field shown', tier: 3, key: 'k', covers: [], sourceRefs: ['spec#1'], acRefs: ['S1/AC-1'] })], flows: [] }) as never;
  const rule = (b: never) => runGate(b).findings.find(x => x.rule === 'step-compound');
  it('flags chained actions, including in postSteps, and conditional clicks', () => {
    expect(rule(kase(['点击币对名→在 Search 输入 BTC→点击 BTC-USDC']))?.args).toEqual({ steps: '1' });
    expect(rule(kase(['在杠杆框输入 41 并点击确认']))).toBeDefined();
    expect(rule(kase(['点击「Place Order」提交限价买单，出现确认框时点确认']))).toBeDefined();
    expect(rule(kase(['Click Place Order', 'If a confirmation dialog appears, click Confirm']))?.args).toEqual({ steps: '2' });
    expect(rule(kase(['Click Close'], ['Click Market Close and then click Confirm']))?.args).toEqual({ steps: 'post 1' });
  });
  it('leaves single actions alone', () => {
    expect(rule(kase(['按 Escape 键关闭划转界面，不点任何确认按钮', '点击弹窗右上角的关闭按钮，不点「Confirm」']))).toBeUndefined();
    expect(rule(kase(['Click the Buy / Long tab', '在 Size 输入 0.01', '点击 Place Order', 'waitFor: the order row shows up, then read it']))).toBeUndefined();
  });
});

describe('absence asserted on the removal step', () => {
  // 2026-09-27 C-POS-04-03：关闭后当步核对「没有了」失败，界面还没刷新。
  const kase = (afterStep: number) => ({ stories: [{ id: 'S1', title: 's', acceptance: ['a'] }], cases: [readOnly({ id: 'C1', storyId: 'S1', title: 't', designMethod: 'equivalence', steps: ['Click the row Cancel button', 'Click the History tab'], postSteps: [], expected: 'Row gone', tier: 1, key: 'k|p|a', priority: 'P1', scenarioType: 'positive', sourceRefs: ['spec#1'], assertions: [{ id: 'A1', afterStep, statement: 'row gone', oracle: { kind: 'noText', value: 'Row 1' } }] })], flows: [] }) as never;
  it('warns when noText follows the removing step directly, not one step later', () => {
    expect(runGate(kase(1)).findings.find(x => x.rule === 'absence-same-step')?.args).toEqual({ assertions: 'A1' });
    expect(runGate(kase(2)).findings.some(x => x.rule === 'absence-same-step')).toBe(false);
  });
});

describe('ui literals must come from the materials', () => {
  // docs/v3/15 2.4b：界面字面值在领域参考与检索材料里都查不到，多半是凭印象写的。
  const kase = (steps: string[], value: string) => ({ stories: [{ id: 'S1', title: 's', acceptance: ['a'] }], cases: [readOnly({ id: 'C1', storyId: 'S1', title: 't', designMethod: 'equivalence', steps, postSteps: [], expected: 'shown', tier: 1, key: 'k|p|a', priority: 'P1', scenarioType: 'positive', sourceRefs: ['spec#1'], assertions: [{ id: 'A1', statement: 'shown', oracle: { kind: 'text', value } }] })], flows: [] }) as never;
  const known = 'The order panel has a Place Order button.\nAfter an order: Open Orders (1) tab, toast "Order placed".';
  it('warns on oracle values and quoted step labels the materials never show', () => {
    const f = runGate(kase(['点击「Submit Order」', 'Click "Place Order"'], 'Order submitted'), { knownText: known }).findings.find(x => x.rule === 'literal-unsourced');
    expect(f?.args).toEqual({ literals: 'Order submitted, Submit Order' });
  });
  it('matches ignoring case and spacing, and skips variables and bare numbers', () => {
    expect(runGate(kase(['Click "place  order"', '输入「${env.SIZE}」', '输入「0.001」'], 'open orders (1)'), { knownText: known }).findings.some(x => x.rule === 'literal-unsourced')).toBe(false);
  });
  it('does nothing without materials', () => {
    expect(runGate(kase(['点击「Submit Order」'], 'Order submitted')).findings.some(x => x.rule === 'literal-unsourced')).toBe(false);
  });
});

describe('ui literals admitted as unverified', () => {
  it('stops flagging a literal the case itself names as unverified in readiness.reason', () => {
    const bundle = { stories: [{ id: 'S1', title: 's', acceptance: ['a'] }], cases: [readOnly({ id: 'C1', storyId: 'S1', title: 't', designMethod: 'equivalence', steps: ['Click "Market Close"'], postSteps: [], expected: 'closed', tier: 1, key: 'k|p|a', priority: 'P1', scenarioType: 'positive', sourceRefs: ['spec#1'], readiness: { design: 'candidate', execution: 'ready', reason: 'Market Close button name is unverified' } })], flows: [] } as never;
    expect(runGate(bundle, { knownText: 'nothing relevant' }).findings.some(x => x.rule === 'literal-unsourced')).toBe(false);
  });
});
