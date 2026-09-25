import { expect, it, vi } from 'vitest';
/** 判据里的 ${env.*} 在判之前换成执行值（2026-09-25：以前从没换，text 必挂、noText 必过）。secret 不换。 */
vi.mock('../src/exec/session.js', () => ({ launchSession: async () => ({
  page: { url: () => 'https://example.test/', isClosed: () => false, screenshot: async () => Buffer.from('png'), evaluate: async (fn: Function) => fn.toString().includes('.split(') ? ['Ready'] : 'Ready\nPrice 42,000\nPNL\n$0.00\nEND' },
  agent: { aiAction: async () => {}, aiAssert: async () => {} }, cleanup: async () => {}, modelRequests: [] }), reopenPage: vi.fn() }));
vi.mock('../src/exec/pageReady.js', () => ({ settleOn: async () => ({ settled: true, controls: 1, textLen: 5, ms: 0 }) }));
vi.mock('../src/baselines/perf.js', () => ({ capturePerf: async () => ({}) }));
import { executeRun } from '../src/exec/run.js';
const base = { executorModel: { baseUrl: 'https://f.test', apiKey: 'f', model: 'f' } as never, resolve: { env: { P: '42,000', ZERO: '0' }, secrets: { S: 'hunter2' } } };
it('resolves env placeholders in text, noText and decimal-equation oracles', async () => {
  expect((await executeRun('https://example.test', ['Look'], 'Ready', { ...base, oracle: { kind: 'text', value: '${env.P}' } })).status).toBe('passed');
  expect((await executeRun('https://example.test', ['Look'], 'Ready', { ...base, oracle: { kind: 'noText', value: '${env.P}' } })).status).toBe('failed');
  const eq = { kind: 'decimal-equation', scope: { start: 'Ready', end: 'END' }, inputs: [{ id: 'pnl', label: 'PNL', unit: '$', decimals: 2, rounding: 'exact' }], actual: 'pnl', formula: ['${env.ZERO}'], maxAgeMs: 60000 } as never;
  expect((await executeRun('https://example.test', ['Look'], 'Ready', { ...base, assertions: [{ statement: 'PNL is zero', oracle: eq, afterStep: 1 }] })).status).toBe('passed');
});
it('never resolves secrets into an oracle', async () => {
  const r = await executeRun('https://example.test', ['Look'], 'Ready', { ...base, oracle: { kind: 'text', value: '${secret.S}' } });
  expect(JSON.stringify(r.oracle)).not.toContain('hunter2');
});
it('a plain number matches the screen with or without thousands separators', async () => {
  const { evaluateOracle, numberForms } = await import('../src/exec/oracle.js');
  expect(numberForms('42000')).toEqual(['42000', '42,000']);
  expect(numberForms('120,000.5')).toEqual(['120,000.5', '120000.5']);
  expect(numberForms('BTC')).toEqual(['BTC']);
  const snap = { text: 'Limit BTC 0.001 @ 42,000', url: 'x' };
  expect(evaluateOracle({ kind: 'text', value: '42000' }, snap as never).status).toBe('pass');
  expect(evaluateOracle({ kind: 'noText', value: '42000' }, snap as never).status).toBe('fail');
});
