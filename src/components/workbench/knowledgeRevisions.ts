import type { Revision } from '@/lib/workflowRuns';
/** Collapse duplicate knowledge bytes, not distinct versions or unrelated documents. */
export function uniqueKnowledgeRevisions(revisions: Revision[]): Revision[] {
  const groups = new Map<string, Revision>();
  for (const r of revisions) {
    const key = r.name.startsWith('knowledge/') && r.contentHash
      ? JSON.stringify([r.runId, r.name, r.kind, r.contentHash]) : r.id;
    const prior = groups.get(key);
    if (!prior || r.revision > prior.revision) groups.set(key, r);
  }
  return [...groups.values()];
}
