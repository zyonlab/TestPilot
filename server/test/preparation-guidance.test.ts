import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_FIXES, GUIDES, GUIDE_NAMES, withFix } from '../src/preparationGuidance.js';
import { LedgerError } from '../src/runLedger.js';

/**
 * docs/v3/15 阶段 3：常驻提示词小、说明按需读一层、每个拒绝都带修法。
 * 这几条钉住「以后加一个拒绝就要写修法」「说明名单两边一致」「常驻部分别再长回去」。
 */
describe('preparation guidance', () => {
  it('every rejection thrown by preparation carries a fix', () => {
    const src = readFileSync(new URL('../src/preparation.ts', import.meta.url), 'utf8');
    const codes = [...new Set([...src.matchAll(/LedgerError\(\d{3},'([a-z_]+)'\)/g)].map((m) => m[1]!))];
    expect(codes.length).toBeGreaterThan(20);
    expect(codes.filter((c) => !ERROR_FIXES[c])).toEqual([]);
  });
  it('attaches the fix once and leaves unknown errors alone', () => {
    const e = withFix(new LedgerError(400, 'recipe_setup_mismatch')) as LedgerError;
    expect(e.hint).toMatch(/recipe\.steps/);
    expect((withFix(new LedgerError(400, 'something_else')) as LedgerError).hint).toBeUndefined();
    expect(withFix(new Error('plain'))).toBeInstanceOf(Error);
  });
  it('keeps the resident prompt small and lists every guide by when-to-read', async () => {
    const { preparationInstructions } = await import('../src/preparation.js');
    const text = preparationInstructions('run-x', 'batch-y');
    expect(text.length).toBeLessThan(4500);
    for (const n of GUIDE_NAMES) expect(text).toContain(`- ${n}: ${GUIDES[n].when}`);
  });
  it('the MCP tool offers exactly the server guide names', () => {
    const mcp = readFileSync(new URL('../../packages/testpilot-mcp/src/server.ts', import.meta.url), 'utf8');
    const listed = /guide:z\.enum\(\[([^\]]+)\]\)/.exec(mcp)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(listed).toEqual(GUIDE_NAMES);
  });
});
