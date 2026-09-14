import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { useT } from '@/lib/prefs';
import { workflowBase, workflowHref, workflowRequest, type WorkflowRun } from '@/lib/workflowRuns';
/** A shared entry on legacy pages prevents host and Web revisions forming separate inventories. */
export function ProjectRevisionLinks() {
  const projectId = useStore(s => s.activeProjectId), t = useT(), [runs, setRuns] = useState<WorkflowRun[]>([]);
  useEffect(() => { setRuns([]); if (!projectId) return; const c = new AbortController(); void workflowRequest<{ runs: WorkflowRun[] }>(workflowBase(projectId), undefined, 'GET', c.signal).then(r => setRuns(r.runs.filter(r => r.provenance === 'registered'))).catch(() => {}); return () => c.abort(); }, [projectId]);
  return <section className="border-b border-border bg-muted/20 px-4 py-3 text-sm"><a href="#/?open=wfruns" className="font-medium underline">{t('workflow.title')} →</a>{runs.length > 0 && <div className="mt-2 flex max-h-24 flex-wrap gap-2 overflow-auto">{runs.slice(0, 12).map(r => <a key={r.id} href={workflowHref(r.id)} className="rounded border border-border bg-card px-2 py-1 text-xs hover:border-primary">{r.id.slice(0, 16)} · {t(`workflow.status.${r.status}`)}</a>)}</div>}</section>;
}
