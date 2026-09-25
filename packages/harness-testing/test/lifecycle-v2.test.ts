import { describe, expect, it } from 'vitest';
import { LifecycleSchema, lifecycleExecution, lifecycleIssues, lifecycleIssueHint, normalizeLifecycle } from '../src/exec/lifecycle.js';

/**
 * v2（2026-09-24）：交易类 SPA 的状态变化大多不是「新建带标签的记录」。
 * 这里钉住五种形状各自的义务，以及校验器与执行器对它们说同一种话。
 */
const check = (value: string, kind: 'text' | 'noText' = 'text') => ({ statement: value, checks: [{ kind: 'screen' as const, statement: value, oracle: { kind, value } }] });
const common = { rationale: 'r', sourceRefs: ['spec#1'], supports: ['$expected'], baseline: [check('Ready')] };
const kase = (lifecycle: unknown, steps: string[], postSteps: string[] = []) => ({ lifecycle: LifecycleSchema.parse(lifecycle), steps, postSteps, sourceRefs: ['spec#1'] });

describe('checker', () => {
  it('read-only may switch tabs and change the session without postSteps', () => {
    expect(lifecycleIssues(kase({ version: 2, mode: 'read-only', ...common, session: 'changed' }, ['Click the History tab', 'Click Disconnect']))).toEqual([]);
  });
  it('read-only with a "restore the tab" postStep is still a mutation, and the hint says why', () => {
    const issues = lifecycleIssues(kase({ version: 2, mode: 'read-only', ...common }, ['Click History'], ['Click back to Positions']));
    expect(issues).toContain('lifecycle_readonly_mutation');
    expect(lifecycleIssueHint('lifecycle_readonly_mutation')).toMatch(/fresh page/);
  });
  it('a persisted setting is restored to its original value and verified on screen', () => {
    const lifecycle = { version: 2, mode: 'controlled', ...common,
      settings: [{ id: 'lev', sourceRef: 'spec#1', name: 'leverage of market A', original: '20x', changedAfterStep: 2, observed: check('20x') }],
      cleanup: [{ id: 'restore', settingId: 'lev', postStep: 1, verified: check('20x') }] };
    expect(lifecycleIssues(kase(lifecycle, ['Open leverage', 'Set leverage to 5x'], ['Set leverage back to 20x']))).toEqual([]);
    expect(lifecycleIssues(kase(lifecycle, ['Open leverage', 'Set leverage to 5x'], ['Undo it']))).toContain('lifecycle_cleanup_unbound:restore');
    expect(lifecycleIssues(kase({ ...lifecycle, settings: [{ ...lifecycle.settings[0], observed: check('10x') }] }, ['a', 'b'], ['Set leverage back to 20x']))).toContain('lifecycle_setting_unbound:lev');
  });
  it('a slot is identified by its key and proven vacant; no screen check has to name a runner id', () => {
    const lifecycle = { version: 2, mode: 'controlled', ...common,
      resources: [{ id: 'pos', sourceRef: 'spec#1', identityKind: 'slot', identity: 'market A', establishAfterStep: 2, established: check('Close'), ownership: check('0xabc'), vacant: check('No open positions') }],
      cleanup: [{ id: 'close', resourceId: 'pos', postStep: 1, verified: check('No open positions') }] };
    expect(lifecycleIssues(kase(lifecycle, ['Type size', 'Buy market A'], ['Close the market A row']))).toEqual([]);
    expect(() => LifecycleSchema.parse({ ...lifecycle, resources: [{ ...lifecycle.resources[0], vacant: undefined }] })).toThrow(/vacant/);
  });
  it('an attribute identity carries a preparer-bound variable and every check names it', () => {
    const id = 'limit order at ${env.TP_ORDER_PRICE}';
    const lifecycle = { version: 2, mode: 'controlled', ...common,
      resources: [{ id: 'ord', sourceRef: 'spec#1', identityKind: 'attribute', identity: id, establishAfterStep: 1, established: check('${env.TP_ORDER_PRICE}'), ownership: check('0xabc') }],
      cleanup: [{ id: 'cancel', resourceId: 'ord', postStep: 1, verified: check('${env.TP_ORDER_PRICE}', 'noText') }] };
    const issues = lifecycleIssues(kase(lifecycle, [`Place ${id}`], [`Cancel ${id}`]));
    expect(issues).toContain('lifecycle_ownership_unbound:ord');
    expect(issues).toContain('lifecycle_establish_evidence_unbound:ord');
    expect(() => LifecycleSchema.parse({ ...lifecycle, resources: [{ ...lifecycle.resources[0], identity: 'limit order' }] })).toThrow(/env/);
  });
  it('v1 artifacts still read and check the same way', () => {
    const v1 = { version: 1, mode: 'read-only', ...common, resources: [], cleanup: [] };
    expect(normalizeLifecycle(LifecycleSchema.parse(v1))).toMatchObject({ version: 2, session: 'unchanged', settings: [] });
    expect(lifecycleIssues(kase(v1, ['Click']))).toEqual([]);
  });
});

describe('runtime', () => {
  const io = (screen: { text: string }, acts: string[]) => ({
    check: async (c: { statement: string; checks: unknown[] }) => {
      const o = (c.checks[0] as { oracle: { kind: string; value: string } }).oracle; const has = screen.text.includes(o.value);
      return { statement: c.statement, status: (o.kind === 'noText' ? !has : has) ? 'pass' as const : 'fail' as const };
    },
    resolve: (t: string) => t, redact: (t: string) => t, available: () => true,
    act: async (t: string) => { acts.push(t); if (t.startsWith('Set leverage back')) screen.text = screen.text.replace('5x', '20x'); if (t.startsWith('Close')) screen.text = 'Ready No open positions 0xabc'; },
  });
  it('restores a changed setting and verifies the original value', async () => {
    const screen = { text: 'Ready 20x' }, acts: string[] = [];
    const lc = lifecycleExecution(LifecycleSchema.parse({ version: 2, mode: 'controlled', ...common,
      settings: [{ id: 'lev', sourceRef: 'spec#1', name: 'leverage', original: '20x', changedAfterStep: 1, observed: check('20x') }],
      cleanup: [{ id: 'restore', settingId: 'lev', postStep: 1, verified: check('20x') }] }), ['Set leverage back to 20x'], io(screen, acts));
    await lc.baseline(); lc.beforeStep(1); screen.text = 'Ready 5x'; await lc.afterStep(1);
    const r = await lc.finish();
    expect(acts).toEqual(['Set leverage back to 20x']);
    expect(r.cleanup[0]).toMatchObject({ status: 'pass', resourceId: 'lev' });
    expect(r.pendingResources).toEqual([]);
  });
  it('refuses to start when the slot is already occupied, and closes only after ownership holds', async () => {
    const slot = LifecycleSchema.parse({ version: 2, mode: 'controlled', ...common,
      resources: [{ id: 'pos', sourceRef: 'spec#1', identityKind: 'slot', identity: 'market A', establishAfterStep: 1, established: check('Close'), ownership: check('0xabc'), vacant: check('No open positions') }],
      cleanup: [{ id: 'close', resourceId: 'pos', postStep: 1, verified: check('No open positions') }] });
    const busy = lifecycleExecution(slot, ['Close market A'], io({ text: 'Ready market A Close' }, []));
    await expect(busy.baseline()).rejects.toThrow('LIFECYCLE_SLOT_OCCUPIED');
    const screen = { text: 'Ready No open positions 0xabc' }, acts: string[] = [];
    const lc = lifecycleExecution(slot, ['Close market A'], io(screen, acts));
    await lc.baseline(); lc.beforeStep(1); screen.text = 'Ready market A Close 0xabc'; await lc.afterStep(1);
    const r = await lc.finish();
    expect(r.cleanup[0]!.status).toBe('pass'); expect(r.pendingResources).toEqual([]);
  });
  it('reports session changes so the runner can discard the browser', () => {
    expect(lifecycleExecution(LifecycleSchema.parse({ version: 2, mode: 'read-only', ...common, session: 'changed' }), [], io({ text: '' }, [])).sessionChanged).toBe(true);
    expect(lifecycleExecution(undefined, [], io({ text: '' }, [])).sessionChanged).toBe(false);
  });
});

it('re-checks a read-only baseline on a reopened entry page, so UI-only changes do not count as mutations', async () => {
  const screen = { text: 'Ready Market Slippage' };
  const lc = (reopen?: () => Promise<void>) => lifecycleExecution(LifecycleSchema.parse({ version: 2, mode: 'read-only', ...common, baseline: [check('Slippage')] }), [], {
    check: async (c: { statement: string; checks: unknown[] }) => { const o = (c.checks[0] as { oracle: { value: string } }).oracle; return { statement: c.statement, status: screen.text.includes(o.value) ? 'pass' as const : 'fail' as const }; },
    resolve: (t: string) => t, redact: (t: string) => t, available: () => true, act: async () => {}, ...(reopen ? { reopen } : {}),
  });
  const withReopen = lc(async () => { screen.text = 'Ready Market Slippage'; });
  await withReopen.baseline(); withReopen.beforeStep(1); screen.text = 'Ready Limit Price (USDC)';
  expect((await withReopen.finish()).status).toBe('pass');
  screen.text = 'Ready Market Slippage';
  const without = lc(); await without.baseline(); without.beforeStep(1); screen.text = 'Ready Limit Price (USDC)';
  expect((await without.finish()).status).toBe('fail');
});
