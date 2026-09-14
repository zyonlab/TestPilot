import { canonicalJSON } from '@testpilot/harness-core/run-contracts';
import { contentHash, type RunLedger } from './runLedger.js';

// Only server-defined observations enter planner context. No artifact text, answers,
// headers or legacy free-text episodes are copied into this table.
export const MEMORY_FACTS = Object.freeze({
  observation_missing: 'A prior execution could not observe its oracle. Define a unique, typed observation and distinguish missing evidence from a product failure.',
  environment_failed: 'A prior execution could not establish or restore its environment. Verify reset and readiness before testing the product.',
  assertion_failed: 'A prior execution violated an approved assertion. Preserve the original expected result while investigating the application or action path.',
});
type Fact = keyof typeof MEMORY_FACTS;
const policy = 'scoped-execution-facts-v2';
const ttlMs = 30 * 86400_000;
function table(ledger: RunLedger) {
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS run_memory (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, scopeHash TEXT NOT NULL,
    sourceRunId TEXT NOT NULL, sourceRevision TEXT NOT NULL, fact TEXT NOT NULL,
    createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL)`);
}
function scope(ledger: RunLedger, runId: string, projectId: string, targetUrl: string, registeredTarget = true) {
  const run = ledger.requireRun(runId, projectId);
  if (!run.binding.materialsHash || run.input.parameters?.evaluationSplit === 'held-out') return null;
  const target = String(registeredTarget ? run.input.parameters?.targetUrl ?? targetUrl : targetUrl);
  let domain: string; try { const url = new URL(target); if (!['http:', 'https:'].includes(url.protocol)) return null; domain = url.hostname; } catch { return null; }
  return contentHash(canonicalJSON({ policy, projectId, domain, targetHash: contentHash(target),
    pageVersion: run.input.parameters?.pageVersion ?? run.binding.materialsHash,
    materialsHash: run.binding.materialsHash }));
}
export function captureExecutionMemory(ledger: RunLedger, revisionId: string, projectId: string, targetUrl: string) {
  table(ledger);
  const { revision, content } = ledger.readRevision(revisionId, projectId);
  if (revision.kind !== 'execution' || revision.createdBy.kind !== 'system' || revision.createdBy.id !== 'workflow-executor') return [];
  const scopeHash = scope(ledger, revision.runId, projectId, targetUrl, false);
  if (!scopeHash) return [];
  const result = content as { status?: string; results?: Array<{ status?: string; infraError?: unknown }> };
  const facts = new Set<Fact>();
  if (result.status === 'unobservable' || result.results?.some(r => r.status === 'unobservable')) facts.add('observation_missing');
  if (result.status === 'infra_error') facts.add('environment_failed');
  if (result.status === 'failed') facts.add('assertion_failed');
  const createdAt = Date.parse(revision.createdAt);
  for (const fact of facts) ledger.db.prepare('INSERT OR IGNORE INTO run_memory VALUES (?,?,?,?,?,?,?,?)')
    .run(contentHash(`${policy}:${revision.id}:${fact}`), projectId, scopeHash, revision.runId, revision.id, fact, createdAt, createdAt + ttlMs);
  return [...facts];
}
export function selectRunMemory(ledger: RunLedger, runId: string, projectId: string, targetUrl: string, enabled = true, now = Date.now()) {
  table(ledger);
  const scopeHash = scope(ledger, runId, projectId, targetUrl);
  const rows = enabled && scopeHash ? ledger.db.prepare(`SELECT id,sourceRunId,sourceRevision,fact,expiresAt FROM run_memory
    WHERE projectId=? AND scopeHash=? AND sourceRunId<>? AND createdAt<=? AND expiresAt>?
    ORDER BY createdAt DESC,id LIMIT 24`).all(projectId, scopeHash, runId, now, now) as Array<{id:string;sourceRunId:string;sourceRevision:string;fact:Fact;expiresAt:number}> : [];
  const seen = new Set<Fact>();
  const entries = rows.filter(r => Object.hasOwn(MEMORY_FACTS, r.fact) && !seen.has(r.fact) && !!seen.add(r.fact)).slice(0, 3)
    .map(r => ({ ...r, text: MEMORY_FACTS[r.fact] }));
  const context = { policy, enabled, scopeHash, entries,
    notice: 'Historical execution observations, not product requirements. Confirm against current materials. Delivery does not prove attention or benefit.' };
  return { ...context, digest: contentHash(canonicalJSON(context)) };
}
