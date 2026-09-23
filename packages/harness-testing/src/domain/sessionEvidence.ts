import { z } from "zod";
export const SessionChecksSchema = z.array(z.object({
  capability: z.enum(['session','wallet-connected','wallet-identity','wallet-session','trading-authorized']),
  checks: z.array(z.object({kind:z.enum(['connected','address','network','authorized']),label:z.string().trim().min(1).max(256)}).strict()).min(1).max(4),
}).strict()).max(5);

/** Exact visible control text checks, supplied by environment configuration, never by the planner. */
export interface SessionCheck {
  capability: 'session' | 'wallet-connected' | 'wallet-identity' | 'wallet-session' | 'trading-authorized';
  checks: { kind: 'connected' | 'address' | 'network' | 'authorized'; label: string }[];
}
export const sessionCapability = (cap: string) => ['session','wallet-connected','wallet-identity','wallet-session','trading-authorized'].includes(cap);
export function verifySessionChecks(checks: SessionCheck[], labels: string[]) {
  const visible = new Set(labels.map(s => s.trim()));
  return checks.map(check => {
    const required = check.capability === 'session' || check.capability === 'wallet-connected' ? ['connected']
      : check.capability === 'trading-authorized' ? ['connected','address','network','authorized'] : ['connected','address','network'];
    const verified = required.every(kind => check.checks.some(c => c.kind === kind && c.label.trim() && visible.has(c.label.trim())
      && (kind !== 'address' || !/[.…]/.test(c.label))));
    return { capability: check.capability, verified, reason: verified ? 'visible_identity_checks_passed' : 'missing_or_unmatched_visible_identity_checks' };
  });
}
