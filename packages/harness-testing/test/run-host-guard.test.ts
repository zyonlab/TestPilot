import { expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ violations: [] as string[] }));
vi.mock('../src/exec/session.js', () => ({
  launchSession: async () => ({
    page: { url: () => 'https://example.test/', isClosed: () => false, screenshot: async () => Buffer.from('png'), evaluate: async (fn: Function) => fn.toString().includes('.split(') ? ['Ready'] : 'Ready' },
    agent: { aiAction: async (t: string) => { if (t.startsWith('Open')) f.violations.push('https://denied.test/trade'); }, aiAssert: async () => {} },
    guardViolations: f.violations, cleanup: async () => {}, modelRequests: [],
  }),
  reopenPage: vi.fn(),
}));
vi.mock('../src/exec/pageReady.js', () => ({ settleOn: async () => ({ settled: true, controls: 1, textLen: 5, ms: 0 }) }));
vi.mock('../src/baselines/perf.js', () => ({ capturePerf: async () => ({}) }));
import { executeRun } from '../src/exec/run.js';

const opts = { executorModel: { baseUrl: 'https://fixture.test', apiKey: 'fixture', model: 'fixture' } as never, oracle: { kind: 'text' as const, value: 'Ready' } };

it('a case whose session touched a denied host never passes, even if its assertions hold', async () => {
  f.violations.splice(0);
  const result = await executeRun('https://example.test', ['Open the menu link'], 'Ready', opts);
  expect(result.status).toBe('failed');
  expect(result.failureReason).toMatch(/^DENIED_HOST_NAVIGATION: https:\/\/denied\.test/);
});

it('a clean session is unaffected', async () => {
  f.violations.splice(0);
  const result = await executeRun('https://example.test', ['Click Balances'], 'Ready', opts);
  expect(result.failureReason ?? '').not.toContain('DENIED_HOST');
});
