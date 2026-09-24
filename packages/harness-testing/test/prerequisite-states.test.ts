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
  const bundle = (requiresStates?: Array<{ state: string; provided: 'steps' | 'preparation' }>, acRefs = ['S1/AC-1']) => ({
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
