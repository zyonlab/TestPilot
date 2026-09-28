import { describe, expect, it } from 'vitest';
import { runGate } from '../src/casegen/gate.js';
import { readOnly } from './helpers/lifecycle.js';
import { evaluateOracle, MachineOracleSchema, type RecordedReadings } from '../src/exec/index.js';

/**
 * docs/v3/15 阶段 4：跨步骤读数判据。屏幕文字取自 2026-09-26 测试网持仓表的实录（innerText）：
 * 一格与一格之间是制表符，表头最后一格与第一行第一格之间是空行。
 */
const table = (liq: string, size = '0.00100 BTC') => 'Balances (1)\nPositions (1)\nOpen Orders\nOrder History\nSide\nMarket\nMarket\n\t\nSize\n\t\nPosition Value\n\t\nEntry Price\n\t\nMark Price\n\t\nPNL (ROE %)\n\t\nLiq. Price\n\t\nMargin\n\t\nFunding\n\t\nClose All\n\t\nTP/SL\n\n'
  + `BTC  20x\t\n${size}\n\t\n83.98 USDC\n\t\n83,977\n\t\n83,976\n\t\n-$0.00 (-0.0%) \n\t\n${liq}\n\t$4.20 (Cross)\t\n-$0.00\n\t\nLimit\nMarket\n\t\n-- / --\nDeposit\nBalance\n$980.81`;
const now = () => ({ capturedAt: Date.now(), url: 'u' });
const reading = (id: string, label: string, unit: string, decimals = 0) => MachineOracleSchema.parse({ kind: 'reading', input: { id, label, unit, decimals, rounding: 'exact', row: { key: 'BTC', keyColumn: 'Market' } } });

describe('table row readings', () => {
  it('reads a cell by row key and column header, with or without the unit in the cell', () => {
    const r: RecordedReadings = new Map();
    expect(evaluateOracle(reading('entry', 'Entry Price', 'USDC'), { text: table('70,100'), ...now() }, undefined, r)).toMatchObject({ status: 'pass', detail: '记下 entry = 83977' });
    expect(evaluateOracle(reading('margin', 'Margin', '$', 2), { text: table('70,100'), ...now() }, undefined, r)).toMatchObject({ status: 'pass', detail: '记下 margin = 4.2' });
    expect(evaluateOracle(reading('size', 'Size', 'BTC', 5), { text: table('70,100'), ...now() }, undefined, r)).toMatchObject({ status: 'pass' });
    expect(r.size).toBe(3);
  });
  it('is unobservable for N/A, a foreign unit, a missing row or two rows with the same key', () => {
    const r: RecordedReadings = new Map();
    expect(evaluateOracle(reading('liq', 'Liq. Price', 'USDC'), { text: table('N/A'), ...now() }, undefined, r).status).toBe('unobservable');
    expect(evaluateOracle(reading('pv', 'Position Value', 'BTC', 2), { text: table('1'), ...now() }, undefined, r).status).toBe('unobservable');
    expect(evaluateOracle(reading('liq', 'Liq. Price', 'USDC'), { text: table('1').replace('BTC  20x', 'ETH 20x'), ...now() }, undefined, r).status).toBe('unobservable');
    const twice = table('1').replace('\t\n-- / --', `\t\nBTC 20x\t\n0.002 BTC\t\n-- / --`);
    expect(evaluateOracle(reading('size', 'Size', 'BTC', 5), { text: twice, ...now() }, undefined, r).status).toBe('unobservable');
    expect(r.size).toBe(0);
  });
});

describe('decimal-equation over readings recorded in an earlier step', () => {
  // MAR-03-02 的形状：加保证金前记下强平价，加完之后强平价应当离得更远（多头 → 更低）。
  const later = (compare: string) => MachineOracleSchema.parse({ kind: 'decimal-equation', scope: { start: 'Positions (1)', end: 'Deposit' },
    inputs: [{ id: 'liqAfter', label: 'Liq. Price', unit: 'USDC', decimals: 0, rounding: 'exact', row: { key: 'BTC', keyColumn: 'Market' } }],
    recorded: ['liqBefore'], actual: 'liqAfter', formula: ['liqBefore'], compare, maxAgeMs: 5000 });
  it('compares the later reading with the recorded one', () => {
    const r: RecordedReadings = new Map();
    evaluateOracle(reading('liqBefore', 'Liq. Price', 'USDC'), { text: table('70,100'), ...now() }, undefined, r);
    expect(evaluateOracle(later('lt'), { text: table('65,000'), ...now() }, undefined, r).status).toBe('pass');
    expect(evaluateOracle(later('lt'), { text: table('71,000'), ...now() }, undefined, r).status).toBe('fail');
  });
  it('is unobservable when the earlier reading was never recorded', () => {
    expect(evaluateOracle(later('lt'), { text: table('65,000'), ...now() }, undefined, new Map())).toMatchObject({ status: 'unobservable', detail: '读数 liqBefore 没有在之前的步骤记下' });
  });
  it('computes a weighted average entry from two recorded fills (POS-01-02)', () => {
    const r: RecordedReadings = new Map([['p1', [{ n: 80000n, d: 1n }, { n: 80000n, d: 1n }]], ['p2', [{ n: 90000n, d: 1n }, { n: 90000n, d: 1n }]]]);
    const avg = MachineOracleSchema.parse({ kind: 'decimal-equation', scope: { start: 'Positions (1)', end: 'Deposit' },
      inputs: [{ id: 'entry', label: 'Entry Price', unit: 'USDC', decimals: 0, rounding: 'nearest', row: { key: 'BTC', keyColumn: 'Market' } }],
      recorded: ['p1', 'p2'], actual: 'entry', formula: ['p1', 'p2', '+', '2', '/'], maxAgeMs: 5000 });
    expect(evaluateOracle(avg, { text: table('1').replace('83,977', '85,000'), ...now() }, undefined, r).status).toBe('pass');
    expect(evaluateOracle(avg, { text: table('1').replace('83,977', '86,000'), ...now() }, undefined, r).status).toBe('fail');
  });
});

describe('gate: reading order', () => {
  const liq = (id: string, step: number | undefined, recordId?: string) => ({ id, statement: 's', ...(step ? { afterStep: step } : {}), oracle: recordId
    ? { kind: 'reading', input: { id: recordId, label: 'Liq. Price', unit: 'USDC', decimals: 0, rounding: 'exact', row: { key: 'BTC', keyColumn: 'Market' } } }
    : { kind: 'decimal-equation', scope: { start: 'Positions', end: 'Deposit' }, inputs: [{ id: 'now', label: 'Liq. Price', unit: 'USDC', decimals: 0, rounding: 'exact', row: { key: 'BTC', keyColumn: 'Market' } }], recorded: ['liqBefore'], actual: 'now', formula: ['liqBefore'], compare: 'lt', maxAgeMs: 5000 } });
  const bundle = (assertions: unknown[]) => ({ stories: [{ id: 'S1', title: 's', acceptance: ['a'] }], cases: [readOnly({ id: 'C1', storyId: 'S1', title: 't', designMethod: 'equivalence', steps: ['Click "Margin"', 'Click "Add"'], postSteps: [], expected: 'x', tier: 2, key: 'k|p|a', priority: 'P1', scenarioType: 'positive', sourceRefs: ['spec#1'], assertions })], flows: [] }) as never;
  const rule = (a: unknown[]) => runGate(bundle(a)).findings.find(f => f.rule === 'reading-order');
  it('accepts a reading recorded before the step it is compared after', () => {
    expect(rule([liq('A1', 1, 'liqBefore'), liq('A2', 2)])).toBeUndefined();
    expect(rule([liq('A1', 1, 'liqBefore'), liq('A2', undefined)])).toBeUndefined();
  });
  it('warns on a reading used before it is recorded, never recorded, or never used', () => {
    expect(rule([liq('A1', 2, 'liqBefore'), liq('A2', 2)])?.message).toContain('recorded at or after');
    expect(rule([liq('A2', 2)])?.message).toContain('no reading records');
    expect(rule([liq('A1', 1, 'liqBefore')])?.message).toContain('no decimal-equation uses it');
  });
});

describe('compare sign (POS-02-02)', () => {
  const pnl = MachineOracleSchema.parse({ kind: 'decimal-equation', scope: { start: 'Positions (1)', end: 'Deposit' },
    inputs: [['size', 'Size', 'BTC', 5, 'exact'], ['mark', 'Mark Price', 'USDC', 0, 'nearest'], ['entry', 'Entry Price', 'USDC', 0, 'nearest'], ['pnl', 'PNL (ROE %)', '$', 2, 'nearest']]
      .map(([id, label, unit, decimals, rounding]) => ({ id, label, unit, decimals, rounding, row: { key: 'BTC', keyColumn: 'Market' } })),
    actual: 'pnl', formula: ['size', 'mark', 'entry', '-', '*'], compare: 'sign', maxAgeMs: 5000 });
  const screen = (entry: string, mark: string, pnlText: string) => table('N/A').replace('83,977\n\t\n83,976', `${entry}\n\t\n${mark}`).replace('-$0.00 (-0.0%)', pnlText);
  it('passes when PNL has the sign of Mark − Entry, even where the magnitudes disagree', () => {
    // 2026-09-27 实录：-31 × 0.002 = -0.062，屏幕上 PNL 是 -$0.05——eq 不过，正负一致。
    expect(evaluateOracle(pnl, { text: screen('84,896', '84,865', '-$0.05 (-0.6%)'), ...now() }).status).toBe('pass');
    expect(evaluateOracle(pnl, { text: screen('83,000', '84,000', '+$1.00 (+1.2%)'), ...now() }).status).toBe('pass');
  });
  it('fails on opposite signs and cannot tell when PNL shows as zero', () => {
    expect(evaluateOracle(pnl, { text: screen('83,000', '84,000', '-$1.00 (-1.2%)'), ...now() }).status).toBe('fail');
    expect(evaluateOracle(pnl, { text: screen('83,940', '83,951', '+$0.00 (+0.0%)'), ...now() }).status).toBe('unobservable');
  });
});
