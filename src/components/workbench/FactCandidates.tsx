import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { WorkflowError, workflowRequest } from '@/lib/workflowRuns';

interface Evidence { runId: string; caseId: string; receipt: string; kind: 'screen' | 'reported'; excerpt: string; at: string }
interface Candidate {
  id: string; literal: string; status: 'pending' | 'accepted' | 'dismissed'; seen: number; evidence: Evidence[];
  decision?: { by: string; at: string; note: string; fact?: string; referenceId?: string };
}

const field = 'mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

/**
 * 界面事实候选（docs/v3/15 阶段 7）：准备与执行里说到、领域参考里还没有的界面字面值。
 *
 * 自动的是收集；并进领域参考要人点头，并且要写一句「它在什么情况下出现」——那句话原样进领域参考，
 * 下一次运行开始时冻结绑定，用例节点就能照着写。
 */
export function FactCandidates({ projectId, runId }: { projectId: string; runId: string }) {
  const t = useT();
  const base = `projects/${encodeURIComponent(projectId)}/fact-candidates`;
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await workflowRequest<{ candidates: Candidate[] }>(base, undefined, 'GET', signal);
      if (!signal?.aborted) setCandidates(r.candidates);
    } catch (e) { if (!signal?.aborted) setError(e instanceof WorkflowError ? e.code : 'request_failed'); }
  }, [base]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);

  async function run(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { setMessage(await fn()); await load(); }
    catch (e) { setError(e instanceof WorkflowError ? (e.detail ?? e.code) : 'request_failed'); }
    finally { setBusy(false); }
  }
  const mine = () => run(async () => {
    const r = await workflowRequest<{ results: number; candidates: unknown[] }>(`${base}/mine`, { runId });
    return t('facts.mined', { results: r.results, candidates: r.candidates.length });
  });
  const decide = (c: Candidate, decision: 'accepted' | 'dismissed') => run(async () => {
    await workflowRequest(`${base}/${encodeURIComponent(c.id)}`, { decision, ...(decision === 'accepted' ? { fact: facts[c.id] ?? '' } : {}) });
    return t(decision === 'accepted' ? 'facts.acceptedMsg' : 'facts.dismissedMsg', { literal: c.literal });
  });

  const pending = candidates.filter((c) => c.status === 'pending');
  const decided = candidates.filter((c) => c.status !== 'pending');
  const card = (c: Candidate) => <li key={c.id} className="rounded-md border border-border p-4 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded bg-muted/50 px-1.5 py-0.5 font-medium">{c.literal}</code>
      <span className="rounded border border-border px-1.5 py-0.5 text-[0.6875rem]">{t(c.evidence.some((e) => e.kind === 'screen') ? 'facts.screen' : 'facts.reported')}</span>
      {c.seen > 1 && <span className="text-xs text-muted-foreground">{t('regression.seen', { n: c.seen })}</span>}
      {c.status !== 'pending' && <span className="ml-auto text-xs text-muted-foreground">{t(`facts.status.${c.status}`)}</span>}
    </div>
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{c.evidence.slice(-2).map((e) => <li key={e.receipt + e.caseId} className="break-words"><span className="font-mono">{e.caseId}</span> · {e.excerpt}</li>)}</ul>
    {c.status === 'pending' ? <div className="mt-3 space-y-2">
      <label className="block text-xs">{t('facts.statement')}<textarea className={field} rows={2} value={facts[c.id] ?? ''} onChange={(e) => setFacts((prev) => ({ ...prev, [c.id]: e.target.value }))} placeholder={t('facts.statementPlaceholder')} /></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy || (facts[c.id] ?? '').trim().length < 4} onClick={() => void decide(c, 'accepted')}>{t('facts.accept')}</Button>
        <Button size="sm" disabled={busy} onClick={() => void decide(c, 'dismissed')}>{t('regression.dismiss')}</Button>
      </div>
    </div> : c.decision && <p className="mt-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.decision.by} · {new Date(c.decision.at).toLocaleString()}{c.decision.fact ? ` · ${c.decision.fact}` : ''}</p>}
  </li>;

  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t('facts.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">{t('facts.title')} <span className="font-mono text-muted-foreground">{pending.length}</span></h3><p className="mt-1 text-xs text-muted-foreground">{t('facts.help')}</p></div>
      <Button size="sm" disabled={busy} onClick={() => void mine()}>{t('facts.mine')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-bad">{t('workflow.requestFailed')} <code className="break-all">{error}</code></p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {pending.length === 0 ? <p className="text-sm text-muted-foreground">{t('facts.nonePending')}</p> : <ul className="space-y-3">{pending.map(card)}</ul>}
    {decided.length > 0 && <details className="text-sm"><summary className="cursor-pointer">{t('regression.decided', { n: decided.length })}</summary><ul className="mt-3 space-y-3">{decided.map(card)}</ul></details>}
  </section>;
}
