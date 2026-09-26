import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ text: 'Ready', calls: [] as string[], failClose: false }));
vi.mock('../src/exec/session.js', () => ({ launchSession: async () => ({
  page: { url: () => 'https://example.test/', isClosed: () => false, goto: async () => {}, screenshot: async () => Buffer.from('png'), evaluate: async (fn: Function) => fn.toString().includes('.split(') ? ['Ready'] : f.text },
  agent: { aiAction: async (t: string) => { f.calls.push(t); if (t.startsWith('Close the missing')) throw new Error('Failed to plan actions: no such row'); if (t.startsWith('Open a holding')) f.text += '\nholding row'; if (t.startsWith('Close the holding') && !f.failClose) f.text = f.text.replace('\nholding row', ''); }, aiAssert: async () => {} },
  cleanup: async () => {}, modelRequests: [] }), reopenPage: vi.fn() }));
vi.mock('../src/exec/pageReady.js', () => ({ settleOn: async () => ({ settled: true, controls: 1, textLen: 5, ms: 0 }) }));
vi.mock('../src/baselines/perf.js', () => ({ capturePerf: async () => ({}) }));
import { executeRun } from '../src/exec/run.js';

/**
 * 受控配方（2026-09-24）：执行准备为用例建立一个前提状态，用例结束后按倒序补偿并在屏幕上核实。
 * 补偿没核实的，记成待处理资源、用例不算通过、不许自动重试。
 */
const check = (value: string, kind: 'text' | 'noText' = 'text') => ({ statement: value, checks: [{ kind: 'screen' as const, statement: value, oracle: { kind, value } }] });
const recipe = { capability: 'holding.open', requires: ['an open holding exists'], entryChecks: [check('Ready')], steps: ['Open a holding'], postconditions: [check('holding row')],
  sideEffects: 'controlled' as const, provides: ['holding.open'], cleanup: [], compensation: [{ step: 'Close the holding row', verified: check('holding row', 'noText') }] };
const opts = () => ({ executorModel: { baseUrl: 'https://fixture.test', apiKey: 'fixture', model: 'fixture' } as never, oracle: { kind: 'text' as const, value: 'Ready' },
  preparation: { steps: recipe.steps, checks: [], recipe } });
beforeEach(() => { f.text = 'Ready'; f.calls = []; f.failClose = false; });

it('undoes what the recipe established after the case and verifies it on screen', async () => {
  const result = await executeRun('https://example.test', ['Look at the holding row'], 'Ready', opts());
  expect(f.calls).toEqual(['Open a holding', 'Look at the holding row', 'Close the holding row']);
  expect(result.lifecycle?.cleanup).toContainEqual(expect.objectContaining({ id: 'recipe-compensation-1', status: 'pass' }));
  expect(result.lifecycle?.pendingResources).toEqual([]);
  expect(result.lifecycle?.safeToRetry).toBe(false);
  expect(result.status).toBe('passed');
});

it('an unverified compensation leaves a pending resource and never lets the case pass', async () => {
  f.failClose = true;
  const result = await executeRun('https://example.test', ['Look at the holding row'], 'Ready', opts());
  expect(result.lifecycle?.pendingResources).toContainEqual(expect.objectContaining({ id: 'recipe:holding.open', identity: 'holding.open' }));
  expect(result.status).not.toBe('passed');
});

it('checks the baseline after the recipe establishes the state the case requires', async () => {
  const lifecycle = { version: 2, mode: 'read-only', rationale: 'reads the holding row', sourceRefs: ['spec#1'], supports: ['$expected'],
    baseline: [{ statement: 'an open holding exists', checks: [{ kind: 'screen', statement: 'an open holding exists', oracle: { kind: 'text', value: 'holding row' } }] }],
    session: 'unchanged', resources: [], settings: [], cleanup: [], sideEffects: [] };
  const result = await executeRun('https://example.test', ['Look at the holding row'], 'Ready', { ...opts(), lifecycle: lifecycle as never, sourceRefs: ['spec#1'], precondition: ['an open holding exists'] });
  expect(result.lifecycle?.checks).toContainEqual(expect.objectContaining({ phase: 'baseline', status: 'pass' }));
  expect(f.calls[0]).toBe('Open a holding');
  expect(result.status).toBe('passed');
});

it('runs compensation top to bottom, in the order it was written', async () => {
  const two = { ...recipe, compensation: [{ step: 'Close the holding row', verified: check('holding row', 'noText') }, { step: 'Return to the entry market', verified: check('Ready') }] };
  await executeRun('https://example.test', ['Look at the holding row'], 'Ready', { ...opts(), preparation: { steps: recipe.steps, checks: [], recipe: two } });
  expect(f.calls.slice(-2)).toEqual(['Close the holding row', 'Return to the entry market']);
});

it('a compensation action that cannot run because the state is already undone counts as done when its check holds', async () => {
  const gone = { ...recipe, steps: ['Look around'], postconditions: [check('Ready')], compensation: [{ step: 'Close the missing row', verified: check('holding row', 'noText') }] };
  const result = await executeRun('https://example.test', ['Look at the page'], 'Ready', { ...opts(), preparation: { steps: gone.steps, checks: [], recipe: gone } });
  expect(result.lifecycle?.cleanup).toContainEqual(expect.objectContaining({ id: 'recipe-compensation-1', status: 'pass', detail: expect.stringMatching(/already undone/) }));
  expect(result.lifecycle?.pendingResources).toEqual([]);
});
it('when the action fails and the check still does not hold, the resource stays pending', async () => {
  const stuck = { ...recipe, compensation: [{ step: 'Close the missing row', verified: check('holding row', 'noText') }] };
  const result = await executeRun('https://example.test', ['Look at the holding row'], 'Ready', { ...opts(), preparation: { steps: recipe.steps, checks: [], recipe: stuck } });
  expect(result.lifecycle?.pendingResources).toHaveLength(1);
});

it('a failed intermediate compensation check is forgiven when the entry checks hold again afterwards', async () => {
  const mid = { ...recipe, entryChecks: [check('holding row', 'noText')], compensation: [{ step: 'Close the holding row', verified: check('holding row') }] };
  const result = await executeRun('https://example.test', ['Look at the holding row'], 'Ready', { ...opts(), preparation: { steps: recipe.steps, checks: [], recipe: mid } });
  expect(result.lifecycle?.cleanup).toContainEqual(expect.objectContaining({ id: 'recipe-entry-restored', status: 'pass' }));
  expect(result.lifecycle?.pendingResources).toEqual([]);
});
