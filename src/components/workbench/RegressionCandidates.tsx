import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { WorkflowError, workflowBase, workflowRequest } from '@/lib/workflowRuns';

interface OracleEvidence { status?: string; decidedBy?: string; assertion?: string; detail?: string }
interface Candidate {
  id: string; kind: 'defect' | 'rejection'; caseId: string; title: string; status: 'pending' | 'approved' | 'dismissed';
  seen: number; createdAt: string;
  evidence: { failureCode?: string | null; failureReason?: string; change?: string | null; oracle?: OracleEvidence[]; reason?: string; rejectedBy?: string | null; executionId?: string };
  decision?: { by: string; at: string; note: string };
}
interface SuiteEntry { id: string; kind: string; role: string; caseId: string; title: string; approvedBy: string; approvedAt: string; note: string }

const field = 'mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';
const STATUS_TONE = { pending: 'border-warn/40 text-warn', approved: 'border-ok/40 text-ok', dismissed: 'border-border text-muted-foreground' } as const;

/**
 * 回归候选：执行里判定失败、或带理由被驳回的用例，等人决定要不要进项目回归集。
 *
 * 批准与驳回是人的决定（服务端 `human_review_required`）。这里把判据的原话和判官的理由摆出来，
 * 因为 2026-09-16 测试网那一批判定失败，逐条看理由才发现一条都不是产品的问题。
 */
export function RegressionCandidates({ projectId, runId, hasExecutions }: { projectId: string; runId: string; hasExecutions: boolean }) {
  const t = useT();
  const base = `${workflowBase(projectId)}/${encodeURIComponent(runId)}/regression-candidates`;
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [suite, setSuite] = useState<SuiteEntry[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [c, s] = await Promise.all([
        workflowRequest<{ candidates: Candidate[] }>(base, undefined, 'GET', signal),
        workflowRequest<{ entries: SuiteEntry[] }>(`projects/${encodeURIComponent(projectId)}/regression-suite`, undefined, 'GET', signal),
      ]);
      if (!signal?.aborted) { setCandidates(c.candidates); setSuite(s.entries); }
    } catch (e) { if (!signal?.aborted) setError(e instanceof WorkflowError ? e.code : 'request_failed'); }
  }, [base, projectId]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);

  async function run(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { setMessage(await fn()); await load(); }
    catch (e) { setError(e instanceof WorkflowError ? (e.detail ?? e.code) : 'request_failed'); }
    finally { setBusy(false); }
  }
  const collect = () => run(async () => {
    const r = await workflowRequest<{ created: Candidate[]; updated: Candidate[]; skipped: Array<{ caseId?: string; reason: string }> }>(base, {});
    return t('regression.collected', { created: r.created.length, updated: r.updated.length, skipped: r.skipped.length });
  });
  const decide = (c: Candidate, decision: 'approved' | 'dismissed') => run(async () => {
    await workflowRequest(`${base}/${encodeURIComponent(c.id)}`, { decision, note: notes[c.id] ?? '' });
    return t(decision === 'approved' ? 'regression.approvedMsg' : 'regression.dismissedMsg', { caseId: c.caseId });
  });

  const pending = candidates.filter((c) => c.status === 'pending');
  const decided = candidates.filter((c) => c.status !== 'pending');

  const card = (c: Candidate) => <li key={c.id} className="rounded-md border border-border p-4 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded border border-border px-1.5 py-0.5 text-[0.6875rem]">{t(`regression.kind.${c.kind}`)}</span>
      <span className="min-w-0 break-words font-medium">{c.title}</span>
      <span className="font-mono text-xs text-muted-foreground">{c.caseId}</span>
      {c.seen > 1 && <span className="text-xs text-muted-foreground">{t('regression.seen', { n: c.seen })}</span>}
      <span className={`ml-auto rounded border px-1.5 py-0.5 text-[0.6875rem] ${STATUS_TONE[c.status]}`}>{t(`regression.status.${c.status}`)}</span>
    </div>
    {c.kind === 'defect' ? <>
      <p className="mt-2 text-xs text-muted-foreground">{[c.evidence.failureCode, c.evidence.change ? t('regression.change', { change: c.evidence.change }) : t('regression.noBaseline')].filter(Boolean).join(' · ')}</p>
      {(c.evidence.oracle ?? []).filter((o) => o.status !== 'pass').map((o, i) => <div key={i} className="mt-2 rounded bg-muted/40 p-2 text-xs">
        <p className="text-sm">{o.assertion}</p>
        <p className="mt-1 text-muted-foreground">{t(o.decidedBy === 'judge' ? 'regression.byJudge' : 'regression.byMachine')} · {o.status}</p>
        {o.detail && <p className="mt-1 whitespace-pre-wrap break-words">{o.detail}</p>}
      </div>)}
      {!(c.evidence.oracle ?? []).some((o) => o.status !== 'pass') && c.evidence.failureReason && <p className="mt-2 whitespace-pre-wrap break-words text-xs">{c.evidence.failureReason}</p>}
    </> : <p className="mt-2 whitespace-pre-wrap break-words text-xs"><span className="text-muted-foreground">{t('regression.rejectedBecause', { by: c.evidence.rejectedBy ?? '—' })} </span>{c.evidence.reason}</p>}
    {c.status === 'pending' ? <div className="mt-3 space-y-2">
      <label className="block text-xs">{t('regression.note')}<textarea className={field} rows={2} value={notes[c.id] ?? ''} onChange={(e) => setNotes((prev) => ({ ...prev, [c.id]: e.target.value }))} placeholder={t('regression.notePlaceholder')} /></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(c, 'approved')}>{t(c.kind === 'defect' ? 'regression.approveDefect' : 'regression.approveNegative')}</Button>
        <Button size="sm" disabled={busy} onClick={() => void decide(c, 'dismissed')}>{t('regression.dismiss')}</Button>
      </div>
    </div> : c.decision && <p className="mt-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.decision.by} · {new Date(c.decision.at).toLocaleString()}{c.decision.note ? ` · ${c.decision.note}` : ''}</p>}
  </li>;

  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t('regression.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">{t('regression.title')} <span className="font-mono text-muted-foreground">{pending.length}</span></h3><p className="mt-1 text-xs text-muted-foreground">{t('regression.help')}</p></div>
      <Button size="sm" disabled={busy || !hasExecutions} onClick={() => void collect()}>{t('regression.collect')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-bad">{t('workflow.requestFailed')} <code className="break-all">{error}</code></p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {pending.length === 0 && <p className="text-sm text-muted-foreground">{t('regression.nonePending')}</p>}
    {pending.length > 0 && <ul className="space-y-3">{pending.map(card)}</ul>}
    {decided.length > 0 && <details className="text-sm"><summary className="cursor-pointer">{t('regression.decided', { n: decided.length })}</summary><ul className="mt-3 space-y-3">{decided.map(card)}</ul></details>}
    <details className="text-sm"><summary className="cursor-pointer">{t('regression.suite', { n: suite.length })}</summary>
      {suite.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t('regression.suiteEmpty')}</p> : <ul className="mt-3 space-y-2">{suite.map((e) => <li key={e.id} className="rounded border border-border p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><span className="rounded border border-border px-1.5 py-0.5">{t(`regression.role.${e.role}`)}</span><span className="font-medium">{e.title}</span><span className="font-mono text-muted-foreground">{e.caseId}</span></div>
        <p className="mt-1 text-muted-foreground">{e.approvedBy} · {new Date(e.approvedAt).toLocaleString()}{e.note ? ` · ${e.note}` : ''}</p>
      </li>)}</ul>}
    </details>
  </section>;
}
