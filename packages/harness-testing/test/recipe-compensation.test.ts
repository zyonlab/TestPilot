import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ text: 'Ready', calls: [] as string[], failClose: false }));
vi.mock('../src/exec/session.js', () => ({ launchSession: async () => ({
  page: { url: () => 'https://example.test/', isClosed: () => false, screenshot: async () => Buffer.from('png'), evaluate: async (fn: Function) => fn.toString().includes('.split(') ? ['Ready'] : f.text },
  agent: { aiAction: async (t: string) => { f.calls.push(t); if (t.startsWith('Open a holding')) f.text += '\nholding row'; if (t.startsWith('Close the holding') && !f.failClose) f.text = f.text.replace('\nholding row', ''); }, aiAssert: async () => {} },
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
