import { expect, it } from 'vitest';
import { executionPriority } from '../src/casegen/priority.js';

/** 执行优先级：生命周期主链 × 影响资金 × 高频使用（2026-09-26 用户定），三项全中 P0、两项 P1、其余 P2。 */
const pack = {
  lifecycle: [{ id: 'open', name: 'open', order: 1, featureIds: ['trade.submit'], sourceRefs: [] }],
  features: [{ id: 'trade.submit', moduleId: 'm', name: 'submit', description: '', applicability: 'unresolved', applicabilitySourceRefs: [], usage: 'high' },
    { id: 'history.view', moduleId: 'm', name: 'history', description: '', applicability: 'unresolved', applicabilitySourceRefs: [], usage: 'medium' }],
} as never;
const funds = { risk: { impact: 'funds-and-exposure' } }, info = { risk: { impact: 'information' } };

it('all three factors make P0, two make P1, fewer make P2', () => {
  expect(executionPriority(funds, { featureRefs: ['trade.submit'] }, pack)).toMatchObject({ priority: 'P0', lifecycle: true, funds: true, frequent: true, source: 'rule' });
  expect(executionPriority(info, { featureRefs: ['trade.submit'] }, pack).priority).toBe('P1');
  expect(executionPriority(funds, { featureRefs: ['history.view'] }, pack).priority).toBe('P2');
  expect(executionPriority(info, { featureRefs: ['history.view'] }, pack).priority).toBe('P2');
  expect(executionPriority(funds, { featureRefs: ['history.view'], lifecycleId: 'open' }, pack).priority).toBe('P1');
});
it('without lifecycle or usage data the case keeps its own priority', () => {
  expect(executionPriority({ priority: 'P2', ...funds }, { featureRefs: ['trade.submit'] }, { lifecycle: [], features: [] } as never)).toMatchObject({ priority: 'P2', source: 'case' });
  expect(executionPriority({}, undefined, undefined).priority).toBe('P1');
});
