/** Bounded base-10 arithmetic for financial API values. Never rounds or adds an implicit epsilon. */
export interface Decimal { coefficient: bigint; scale: number }
export function decimal(value: unknown): Decimal | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return;
  const text = String(value).trim(); if (text.length > 256) return;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text); if (!m) return;
  const scale = (m[3]?.length ?? 0) - Number(m[4] ?? 0); if (Math.abs(scale) > 100) return;
  let coefficient = BigInt((m[1] === '-' ? '-' : '') + m[2] + (m[3] ?? ''));
  if (scale < 0) coefficient *= 10n ** BigInt(-scale);
  return { coefficient, scale: Math.max(0, scale) };
}
function align(a: Decimal, b: Decimal) { const scale = Math.max(a.scale, b.scale); return [a.coefficient * 10n ** BigInt(scale-a.scale), b.coefficient * 10n ** BigInt(scale-b.scale)] as const; }
export function compareDecimal(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const x = decimal(a), y = decimal(b); if (!x || !y) return;
  const [left,right] = align(x,y); return left < right ? -1 : left > right ? 1 : 0;
}
export function compareDecimalChange(before: unknown, after: unknown, change: unknown): -1 | 0 | 1 | undefined {
  const a = decimal(before), b = decimal(after), c = decimal(change); if (!a || !b || !c) return;
  const scale = Math.max(a.scale,b.scale,c.scale);
  const actual = b.coefficient * 10n ** BigInt(scale-b.scale) - a.coefficient * 10n ** BigInt(scale-a.scale), expected = c.coefficient * 10n ** BigInt(scale-c.scale);
  return actual < expected ? -1 : actual > expected ? 1 : 0;
}
