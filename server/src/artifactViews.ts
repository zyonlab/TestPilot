import { canonicalJSON } from '@testpilot/harness-core/run-contracts';
import { runLedger } from './runService.js';
import { LedgerError } from './runLedger.js';
/** Content is verified on every read, including ancestry and exports. */
export function revisionLineage(projectId: string, id: string) {
  const visited = new Set<string>(), revisions: ReturnType<ReturnType<typeof runLedger>['readRevision']>[] = [];
  function visit(next: string) {
    if (visited.has(next)) return;
    if (visited.size >= 2000) throw new LedgerError(413, 'lineage_too_large');
    visited.add(next); const artifact = runLedger().readRevision(next, projectId); revisions.push(artifact);
    for (const ref of [...artifact.revision.sourceRefs, ...(artifact.revision.parentRevision ? [artifact.revision.parentRevision] : [])]) visit(ref);
  }
  visit(id); return { schemaVersion: 1, rootRevision: id, revisions };
}
export function revisionDiff(projectId: string, id: string, previous?: string) {
  const current = runLedger().readRevision(id, projectId);
  const oldId = previous ?? current.revision.parentRevision;
  if (!oldId) return { from: null, to: id, changes: [{ path: '/', after: current.content }] };
  const before = runLedger().readRevision(oldId, projectId);
  if (current.revision.artifactId !== before.revision.artifactId) throw new LedgerError(409, 'diff_artifact_conflict');
  const changes: Array<{ path: string; before?: unknown; after?: unknown }> = [];
  function diff(a: unknown, b: unknown, path: string) {
    if (a === b || (a !== undefined && b !== undefined && canonicalJSON(a) === canonicalJSON(b))) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    } else changes.push({ path: path || '/', ...(a !== undefined ? { before: a } : {}), ...(b !== undefined ? { after: b } : {}) });
  }
  diff(before.content, current.content, ''); return { from: oldId, to: id, changes };
}
export function approvalHistory(runId: string, projectId: string) {
  runLedger().requireRun(runId, projectId);
  const exists = runLedger().db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='case_approval_events'").get();
  if (!exists) return [];
  return (runLedger().db.prepare('SELECT json FROM case_approval_events WHERE runId=? ORDER BY rowid').all(runId) as Array<{ json: string }>).map(r => JSON.parse(r.json));
}
