import { z } from 'zod';
import { MachineOracleSchema, evaluateOracle, type PageSnapshot } from './oracle.js';

// Configuration facts describe the harness, never application login, funding or permissions.
export const EnvironmentFactSchema = z.enum(['target-origin', 'injected-wallet', 'injected-account', 'injected-chain', 'authentication']);
const ScreenOracleSchema = MachineOracleSchema.refine(o => !['api', 'delta', 'judge', 'none'].includes(o.kind), 'A prerequisite needs a same-screen deterministic oracle');
export const PrerequisitePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('environment'), fact: EnvironmentFactSchema, expected: z.union([z.string().min(1), z.number(), z.boolean()]) }).strict(),
  z.object({ kind: z.literal('screen'), statement: z.string().min(1).max(2000), oracle: ScreenOracleSchema.optional() }).strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string().min(1).max(2000) }).strict(),
]);
export const PrerequisiteCheckSchema = z.object({
  statement: z.string().min(1).max(4000),
  // Compound reviewed prerequisites require ALL parts; no part can be silently skipped.
  checks: z.array(PrerequisitePartSchema).min(1).max(12),
}).strict();
export const AuxiliaryAssertionSchema = z.object({
  id: z.string().min(1).max(100), statement: z.string().min(1).max(2000),
  supports: z.array(z.string().min(1)).min(1).max(20),
  oracle: MachineOracleSchema.refine(o => o.kind !== 'api', 'Screen evidence required').optional(),
  afterStep: z.number().int().positive().optional(),
}).strict();
export type PrerequisiteCheck = z.infer<typeof PrerequisiteCheckSchema>;
export type AuxiliaryAssertion = z.infer<typeof AuxiliaryAssertionSchema>;
export const SetupRecipeSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/),
  // Exact requirements matched by the planner; the server also requires independent receipts.
  requires: z.array(z.string().min(1).max(4000)).min(1).max(20),
  entryChecks: z.array(PrerequisiteCheckSchema).min(1).max(10),
  steps: z.array(z.string().min(1).max(2000)).min(1).max(15),
  postconditions: z.array(PrerequisiteCheckSchema).min(1).max(10),
  sideEffects: z.enum(['none', 'ui-only']),
  // Mutable fixtures need a separate lifecycle contract; this first recipe tier cannot own one.
  cleanup: z.array(z.string()).max(0),
}).strict();
export type SetupRecipe = z.infer<typeof SetupRecipeSchema>;
export type RecipeRef = { id: string; version: number };
export type Preparation = {
  steps: string[]; checks: Array<string | PrerequisiteCheck>; auxiliaryAssertions?: AuxiliaryAssertion[];
  recipe?: SetupRecipe; recipeRef?: RecipeRef;
};
export type EnvironmentFact = {
  fact: z.infer<typeof EnvironmentFactSchema>; value?: string | number | boolean;
  source: string; capturedAt: number;
};
export type PrerequisiteReceipt = {
  statement: string; status: 'pass' | 'fail' | 'unknown'; detail?: string;
  evidence?: Array<{ kind: string; status: 'pass' | 'fail' | 'unknown'; source: string; capturedAt: number; detail: string }>;
};

/** Never infer environment facts from the visual appearance of a page. */
export async function checkPrerequisite(check: PrerequisiteCheck, input: {
  facts: EnvironmentFact[]; snapshot: () => Promise<PageSnapshot>; assert: (text: string) => Promise<void>;
  resolve: (text: string) => string; redact: (text: string) => string;
}): Promise<PrerequisiteReceipt> {
  const evidence: NonNullable<PrerequisiteReceipt['evidence']> = [];
  for (const part of check.checks) {
    let status: PrerequisiteReceipt['status'] = 'unknown', source = part.kind as string, detail = '', capturedAt = Date.now();
    if (part.kind === 'environment') {
      const fact = input.facts.find(f => f.fact === part.fact);
      source = fact?.source ?? 'runner:missing'; capturedAt = fact?.capturedAt ?? capturedAt;
      const expected = typeof part.expected === 'string' ? input.resolve(part.expected) : part.expected;
      if (fact?.value !== undefined) status = fact.value === expected ? 'pass' : 'fail';
      detail = `${part.fact}: ${status} (expected ${String(expected)}, observed ${String(fact?.value ?? 'unknown')})`;
    } else if (part.kind === 'unknown') detail = part.reason;
    else if (part.oracle) {
      const snap = await input.snapshot();
      const oracle = JSON.parse(JSON.stringify(part.oracle, (_key, value) => typeof value === 'string' ? input.resolve(value) : value));
      const verdict = evaluateOracle(oracle, snap);
      status = verdict.status === 'unobservable' ? 'unknown' : verdict.status;
      source = `page:${snap.url}`; capturedAt = snap.capturedAt ?? capturedAt; detail = verdict.detail;
    } else {
      source = 'page:visual-assertion';
      try { await input.assert(input.resolve(part.statement)); status = 'pass'; detail = part.statement; }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Broken / empty model verdicts are unavailable evidence, not product failures.
        status = !message || /Assertion failed:\s*(undefined|null)?\s*$/i.test(message) ? 'unknown' : 'fail';
        detail = `${part.statement}: ${message || 'No assertion diagnostic returned'}`;
      }
    }
    evidence.push({kind: part.kind, status, source: input.redact(source), capturedAt, detail: input.redact(detail)});
  }
  const status = evidence.some(e => e.status === 'fail') ? 'fail' : evidence.some(e => e.status === 'unknown') ? 'unknown' : 'pass';
  return {statement: check.statement, status, detail: evidence.map(e => e.detail).join('; '), evidence};
}
