import { expect, it } from 'vitest';
import { admissionIssues, statesNeedingRecipe } from '../src/preparationAdmission.js';
import { readOnlyLifecycle } from './helpers/lifecycle.js';

/** 准备前裁决（2026-09-25）：对着用例正文与环境就能判「准备不出来」的，不交给准备器、不花探查。 */
const base = { id: 'c1', storyId: 's1', title: 't', designMethod: 'equivalence', steps: ['Click the Advanced tab'], postSteps: [], expected: 'Panel shown', tier: 3, key: 'k', covers: [], sourceRefs: ['spec#1'], precondition: [], lifecycle: readOnlyLifecycle('spec#1') } as never;
const pack = { persistedSettings: ['Advanced tab'], states: [{ id: 'session.on', kind: 'session', name: 's' }, { id: 'thing.open', kind: 'resource', name: 'r' }] } as never;

it('blocks unbound variables, undeclared persisted settings and multi-action steps; leaves clean cases alone', () => {
  expect(admissionIssues({ ...(base as object), steps: ['Type ${env.MISSING} into Size'] } as never, { vars: {} })[0]).toMatch(/unbound_variables: env.MISSING/);
  expect(admissionIssues(base, { vars: {}, pack }).some(i => i.startsWith('setting-undeclared'))).toBe(true);
  expect(admissionIssues({ ...(base as object), steps: ['Click Place Order, then click Confirm'] } as never, { vars: {} }).some(i => i.startsWith('step-compound'))).toBe(true);
  expect(admissionIssues({ ...(base as object), steps: ['Click the Basic tab'] } as never, { vars: {}, pack })).toEqual([]);
  expect(admissionIssues({ ...(base as object), readiness: { design: 'candidate', execution: 'not-executable', reason: 'needs fault injection' } } as never, { vars: {} })[0]).toMatch(/not_executable: needs fault injection/);
});
it('session-kind states never need a preparation recipe, whatever the case declares', () => {
  const c = { ...(base as object), requiresStates: [{ state: 'session.on', provided: 'preparation' }, { state: 'thing.open', provided: 'preparation' }] } as never;
  expect(statesNeedingRecipe(c, pack)).toEqual(['thing.open']);
  expect(statesNeedingRecipe(c)).toEqual(['session.on', 'thing.open']);
});
