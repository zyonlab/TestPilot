import { expect, it, vi } from 'vitest';
/** 登录一步失败（主区域黑屏、等不到按钮）时重开入口页，整段登录重来一次（2026-09-26）。 */
const f = vi.hoisted(() => ({ waits: 0, gotos: 0 }));
vi.mock('../src/exec/session.js', () => ({ launchSession: async () => ({
  page: { url: () => 'https://example.test/', isClosed: () => false, screenshot: async () => Buffer.from('png'), evaluate: async (fn: Function) => fn.toString().includes('.split(') ? ['Ready'] : 'Ready', goto: async () => { f.gotos++; } },
  agent: { aiAction: async () => {}, aiAssert: async () => {}, aiWaitFor: async () => { f.waits++; if (f.waits === 1) throw new Error('waitFor timeout: main area is blank'); } },
  cleanup: async () => {}, modelRequests: [] }), reopenPage: vi.fn() }));
vi.mock('../src/exec/pageReady.js', () => ({ settleOn: async () => ({ settled: true, controls: 1, textLen: 5, ms: 0 }) }));
vi.mock('../src/baselines/perf.js', () => ({ capturePerf: async () => ({}) }));
import { executeRun } from '../src/exec/run.js';
it('reloads the entry page and retries the whole login once when a login step fails', async () => {
  const r = await executeRun('https://example.test', ['Look'], 'Ready', { executorModel: { baseUrl: 'https://f.test', apiKey: 'f', model: 'f' } as never, oracle: { kind: 'text', value: 'Ready' }, login: ['waitFor: the Enable Trading button', 'Click Enable Trading'] });
  expect(f.waits).toBe(2);
  expect(r.logs?.some(l => /retrying login once/.test(l))).toBe(true);
  expect(r.status).toBe('passed');
});
