import { beforeEach, expect, it, vi } from 'vitest';
import { blockedByOverlay, dismissOverlays, DismissibleOverlaysSchema } from '../src/exec/overlays.js';

/** 常驻可关闭浮层（2026-09-25）：登录后关掉；某步因被挡住失败时，关掉再重试一次。具体面板是环境数据。 */
const f = vi.hoisted(() => ({ text: 'Ready\nNotice panel\nTrade', calls: [] as string[], hideTarget: true, dialog: false, keys: [] as string[] }));
vi.mock('../src/exec/session.js', () => ({ launchSession: async () => ({
  page: { url: () => 'https://example.test/', isClosed: () => false, screenshot: async () => Buffer.from('png'), evaluate: async (fn: Function) => fn.toString().includes('.split(') ? f.text.split('\n') : fn.toString().includes('aria-modal') ? f.dialog : f.text, goto: async () => {}, keyboard: { press: async (k: string) => { f.keys.push(k); f.dialog = false; } } },
  agent: { aiAction: async (t: string) => { f.calls.push(t); if (t === 'Open mode dialog') f.dialog = true; else if (t === 'Click Market' && f.dialog) throw new Error('Failed to plan actions: Market not found'); else if (t === 'Show notice') f.text += '\nNotice panel'; else if (t === 'Close the notice panel') f.text = f.text.replace('\nNotice panel', ''); else if (t === 'Click Isolated') throw new Error('locate: multiple elements found, length = 2'); else if (t === 'Click Withdraw' && f.text.includes('Notice panel')) throw new Error('Failed to plan actions: Withdraw not found, covered by a panel'); }, aiAssert: async () => {} },
  cleanup: async () => {}, modelRequests: [] }), reopenPage: vi.fn() }));
vi.mock('../src/exec/pageReady.js', () => ({ settleOn: async () => ({ settled: true, controls: 1, textLen: 5, ms: 0 }) }));
vi.mock('../src/baselines/perf.js', () => ({ capturePerf: async () => ({}) }));
import { executeRun } from '../src/exec/run.js';
const overlays = [{ id: 'notice', present: 'Notice panel', close: 'Close the notice panel' }];
const opts = (o = overlays) => ({ executorModel: { baseUrl: 'https://fixture.test', apiKey: 'fixture', model: 'fixture' } as never, oracle: { kind: 'text' as const, value: 'Ready' }, overlays: o });
beforeEach(() => { f.text = 'Ready\nNotice panel\nTrade'; f.calls = []; });

it('closes a declared overlay on the entry page before the first step', async () => {
  const result = await executeRun('https://example.test', ['Click Withdraw'], 'Ready', opts());
  expect(f.calls).toEqual(['Close the notice panel', 'Click Withdraw']);
  expect(result.status).toBe('passed');
});
it('when a step is blocked and the overlay came back, closes it and retries the step once', async () => {
  f.text = 'Ready\nTrade';
  const result = await executeRun('https://example.test', ['Show notice', 'Click Withdraw'], 'Ready', opts());
  expect(f.calls).toEqual(['Show notice', 'Click Withdraw', 'Click Withdraw', 'Close the notice panel', 'Click Withdraw']);
  expect(result.status).toBe('passed');
  expect(result.logs?.some(l => /overlay notice dismissed/.test(l))).toBe(true);
});
it('without declared overlays a blocked step fails as before', async () => {
  const result = await executeRun('https://example.test', ['Click Withdraw'], 'Ready', opts([]));
  expect(result.status).not.toBe('passed');
  expect(f.calls).toEqual(['Click Withdraw', 'Click Withdraw']); // 一次 Escape 重试，没有声明浮层就不再多试
});
it('retry path: dismiss runs only for overlay-like failures and only when the overlay is present', async () => {
  expect(blockedByOverlay(new Error('Failed to plan actions: button not found'))).toBe(true);
  expect(blockedByOverlay(new Error('Assertion failed: balance is 0'))).toBe(false);
  expect(blockedByOverlay(new Error('EXEC_CANCELLED'))).toBe(false);
  let text = 'x\nNotice panel'; const acts: string[] = [];
  const io = { text: async () => text, act: async (a: string) => { acts.push(a); text = 'x'; }, settle: async () => {}, log: () => {} };
  expect(await dismissOverlays(overlays, io, 'test')).toBe(1);
  expect(await dismissOverlays(overlays, io, 'test')).toBe(0);
  expect(acts).toEqual(['Close the notice panel']);
  expect(DismissibleOverlaysSchema.safeParse([{ id: 'a', present: '', close: 'x' }]).success).toBe(false);
});

it('an ambiguous target inside a dialog is retried once, scoped to the topmost dialog', async () => {
  f.text = 'Ready\nTrade';
  const result = await executeRun('https://example.test', ['Click Isolated'], 'Ready', opts([]));
  expect(f.calls[1]).toMatch(/^Click Isolated（只在当前最上层打开的弹窗或对话框内操作/);
  expect(result.status).toBe('passed');
});

it('waits for a closing animation and clicks close a second time when the first click did not take', async () => {
  let text = 'x\nNotice panel'; let clicks = 0; let polls = 0;
  const io = { text: async () => { polls++; if (clicks >= 2 && polls > 3) text = 'x'; return text; }, act: async () => { clicks++; }, settle: async () => {}, log: () => {}, sleep: async () => {} };
  expect(await dismissOverlays([{ id: 'n', present: 'Notice panel', close: 'Close it' }], io, 'test')).toBe(1);
  expect(clicks).toBe(2);
});

it('clicks a declared close selector deterministically and falls back to the instruction when it cannot', async () => {
  let text = 'x\nNotice panel'; const acts: string[] = []; const sels: string[] = [];
  const io = { text: async () => text, act: async (a: string) => { acts.push(a); text = 'x'; }, settle: async () => {}, log: () => {}, sleep: async () => {},
    clickSelector: async (s: string) => { sels.push(s); if (s === '#ok') { text = 'x'; return true; } return false; } };
  expect(await dismissOverlays([{ id: 'n', present: 'Notice panel', close: 'Close it', selector: '#ok' }], io, 't')).toBe(1);
  expect(acts).toEqual([]);
  text = 'x\nNotice panel';
  expect(await dismissOverlays([{ id: 'n', present: 'Notice panel', close: 'Close it', selector: '#missing' }], io, 't')).toBe(1);
  expect(acts).toEqual(['Close it']);
});

it('a dialog left open by the previous step is closed with Escape and the step retried once', async () => {
  f.text = 'Ready\nTrade'; f.dialog = false; f.keys = [];
  const result = await executeRun('https://example.test', ['Open mode dialog', 'Click Market'], 'Ready', opts([]));
  expect(f.keys).toEqual(['Escape']);
  expect(f.calls.filter(c => c === 'Click Market')).toHaveLength(2);
  expect(result.status).toBe('passed');
});
