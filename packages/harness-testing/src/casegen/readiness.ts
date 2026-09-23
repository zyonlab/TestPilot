import { lifecycleIssues } from '../exec/lifecycle.js';
import type { TextCase } from './types.js';

/** Design approval is not execution admission. Never infer readiness from a passing design gate. */
export function executionBlockers(c: TextCase): string[] {
  const issues: string[] = c.lifecycle ? lifecycleIssues(c) : [];
  if (c.readiness?.execution !== 'ready') issues.push(c.readiness?.reason || `readiness:${c.readiness?.execution ?? 'not-assessed'}`);
  if (c.readiness?.execution === 'ready' && /(?:缺少?|尚未验证|尚未核实|未具备|待确认|missing\s|unverified|not yet verified)/i.test(c.readiness.reason ?? '')) issues.push('ready_conflicts_with_missing_prerequisite');
  for (const r of c.readiness?.requirements ?? []) if (r.status !== 'verified' || !r.evidenceRefs.length) issues.push(`unverified_requirement:${r.kind}:${r.id}`);
  const assertions = c.assertions?.length ? c.assertions : [{ id: 'expected', statement: c.expected, oracle: c.oracle }];
  for (const a of assertions) {
    const numericFormula = /Σ|×|÷|Qmin|Qold|Qclose|Qremaining|\b[A-Za-z]\s*[+*/]\s*[A-Za-z]\b|十进制|显示区间/.test(a.statement);
    // A top-level oracle only describes the primary expectation, not every extra assertion.
    const oracle = a.oracle ?? (a.statement === c.expected ? c.oracle : undefined);
    if (numericFormula && (!oracle || ['text','noText','none','judge'].includes(oracle.kind))) issues.push(`missing_numeric_calculation:${a.id}`);
    if (!oracle || oracle.kind === 'none') issues.push(`missing_machine_oracle:${a.id}`);
  }
  return [...new Set(issues)];
}
