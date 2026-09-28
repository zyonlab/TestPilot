import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { WorkflowError, workflowRequest } from '@/lib/workflowRuns';

interface Item { caseId: string; runId: string; codeRevision: string; title: string; passes: number; fails: number }
interface StandardSet { id: string; name: string; status: 'draft' | 'frozen'; items: Item[]; itemsHash: string; createdAt: string; frozen?: { by: string; at: string; note: string } }
interface Score { n: number; passed: number; failed: number; unobservable: number; infra: number; notRun: number; passRate: number }
interface Entry { label: string; model: string; endpoint: string; baseline: boolean; status: string; score?: Score; error?: string }
interface Evaluation { id: string; setId: string; status: string; maxItems: number; entries: Entry[]; createdAt: string; recommendation?: string; decision?: { by: string; at: string; label?: string; note: string } }

const field = 'mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

/** 一行一个候选：`名字 | 端点 | 模型 | 项目密钥名（可空） | vlMode（可空）`。 */
function parseCandidates(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [label = '', endpoint = '', model = '', apiKeySecret = '', vlMode = ''] = l.split('|').map((x) => x.trim());
    return { label, endpoint, model, ...(apiKeySecret ? { apiKeySecret } : {}), ...(vlMode ? { vlMode } : {}) };
  });
}

/**
 * 标准测试集与执行模型评估（docs/v3/15 阶段 8～9）。
 *
 * 起草自动：从这次运行真跑通过的用例里挑。冻结、发起评估（会在被测环境里真跑、花额度）、换项目的执行模型，都是人来点。
 */
export function StandardSets({ projectId, runId }: { projectId: string; runId: string }) {
  const t = useT();
  const base = `projects/${encodeURIComponent(projectId)}`;
  const [sets, setSets] = useState<StandardSet[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [candidates, setCandidates] = useState('');
  const [maxItems, setMaxItems] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await workflowRequest<{ sets: StandardSet[]; evaluations: Evaluation[] }>(`${base}/standard-sets`, undefined, 'GET', signal);
      if (!signal?.aborted) { setSets(r.sets); setEvaluations(r.evaluations); }
    } catch (e) { if (!signal?.aborted) setError(e instanceof WorkflowError ? e.code : 'request_failed'); }
  }, [base]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);
  // 评估在后台跑：有进行中的就隔几秒刷新一次。
  useEffect(() => {
    if (!evaluations.some((e) => e.status === 'running')) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [evaluations, load]);

  async function run(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { setMessage(await fn()); await load(); }
    catch (e) { setError(e instanceof WorkflowError ? (e.detail ?? e.code) : 'request_failed'); }
    finally { setBusy(false); }
  }
  const draft = sets.find((s) => s.status === 'draft');
  const frozen = sets.filter((s) => s.status === 'frozen');
  const [setId, setSetId] = useState('');
  const chosen = setId || frozen[0]?.id || '';
  const parsed = useMemo(() => parseCandidates(candidates), [candidates]);

  const makeDraft = () => run(async () => {
    const r = await workflowRequest<StandardSet>(`${base}/standard-sets`, { runIds: [runId] });
    setExcluded(new Set());
    return t('std.drafted', { n: r.items.length });
  });
  const freeze = () => run(async () => {
    const r = await workflowRequest<StandardSet>(`${base}/standard-sets/${encodeURIComponent(draft!.id)}/freeze`, { itemsHash: draft!.itemsHash, exclude: [...excluded] });
    return t('std.frozenMsg', { n: r.items.length });
  });
  const evaluate = () => run(async () => {
    await workflowRequest(`${base}/standard-evaluations`, { setId: chosen, candidates: parsed, maxItems });
    return t('std.evaluationStarted');
  });
  const decide = (e: Evaluation, decision: 'promote' | 'keep', label?: string) => run(async () => {
    await workflowRequest(`${base}/standard-evaluations/${encodeURIComponent(e.id)}`, { decision, ...(label ? { label } : {}) });
    return t(decision === 'promote' ? 'std.promotedMsg' : 'std.keptMsg', { label: label ?? '' });
  });

  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t('std.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">{t('std.title')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('std.help')}</p></div>
      <Button size="sm" disabled={busy} onClick={() => void makeDraft()}>{t('std.draft')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-bad">{t('workflow.requestFailed')} <code className="break-all">{error}</code></p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}

    {draft && <div className="rounded-md border border-border p-3 text-sm">
      <p className="font-medium">{t('std.draftTitle', { n: draft.items.length })}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('std.draftHelp')}</p>
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-xs">{draft.items.map((i) => { const key = `${i.runId}:${i.caseId}`; return <li key={key}>
        <label className="flex items-start gap-2"><input type="checkbox" checked={!excluded.has(key)} onChange={(ev) => setExcluded((prev) => { const next = new Set(prev); if (ev.target.checked) next.delete(key); else next.add(key); return next; })} />
          <span className="min-w-0 break-words"><span className="font-mono">{i.caseId}</span> {i.title} <span className="text-muted-foreground">· {t('std.history', { passes: i.passes, fails: i.fails })}</span></span></label>
      </li>; })}</ul>
      <Button className="mt-3" size="sm" variant="primary" disabled={busy || draft.items.length === excluded.size} onClick={() => void freeze()}>{t('std.freeze', { n: draft.items.length - excluded.size })}</Button>
    </div>}

    {frozen.length > 0 && <div className="space-y-2 text-sm">
      <p className="font-medium">{t('std.frozenSets')}</p>
      <ul className="space-y-1 text-xs">{frozen.map((s) => <li key={s.id}>{s.name} · {t('std.cases', { n: s.items.length })} · {s.frozen?.by} {s.frozen ? new Date(s.frozen.at).toLocaleString() : ''}</li>)}</ul>
      <div className="rounded-md border border-border p-3">
        <p className="font-medium">{t('std.evaluate')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('std.evaluateHelp')}</p>
        <label className="mt-2 block text-xs">{t('std.set')}<select className={field} value={chosen} onChange={(e) => setSetId(e.target.value)}>{frozen.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.items.length}）</option>)}</select></label>
        <label className="mt-2 block text-xs">{t('std.candidates')}<textarea className={`${field} font-mono`} rows={3} value={candidates} onChange={(e) => setCandidates(e.target.value)} placeholder="free-pool | http://127.0.0.1:3001/v1 | auto:executor | FREELLMAPI_KEY | gemini" /></label>
        <label className="mt-2 block text-xs">{t('std.maxItems')}<input className={field} type="number" min={1} max={60} value={maxItems} onChange={(e) => setMaxItems(Number(e.target.value) || 1)} /></label>
        <Button className="mt-3" size="sm" variant="primary" disabled={busy || !chosen || !parsed.length || parsed.some((c) => !c.label || !c.endpoint || !c.model)} onClick={() => void evaluate()}>{t('std.start')}</Button>
      </div>
    </div>}

    {evaluations.length > 0 && <ul className="space-y-3">{evaluations.map((e) => <li key={e.id} className="rounded-md border border-border p-3 text-sm">
      <p className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()} · {t(`std.status.${e.status}`)}{e.recommendation ? ` · ${t('std.recommend', { label: e.recommendation })}` : ''}</p>
      <table className="mt-2 w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th>{t('std.candidate')}</th><th>{t('std.model')}</th><th>{t('std.passRate')}</th><th>{t('std.breakdown')}</th><th /></tr></thead>
        <tbody>{e.entries.map((x) => <tr key={x.label} className="border-t border-border align-top">
          <td className="py-1 pr-2">{x.label}{x.baseline ? ` · ${t('std.baseline')}` : ''}</td>
          <td className="break-all py-1 pr-2 font-mono">{x.model}</td>
          <td className="py-1 pr-2">{x.score ? `${Math.round(x.score.passRate * 100)}%（${x.score.passed}/${x.score.n}）` : t(`std.entry.${x.status}`)}</td>
          <td className="py-1 pr-2">{x.score ? t('std.scoreDetail', { failed: x.score.failed, unobservable: x.score.unobservable, infra: x.score.infra, notRun: x.score.notRun }) : x.error ?? ''}</td>
          <td className="py-1">{e.status === 'awaiting_review' && !x.baseline && x.score && <Button size="sm" disabled={busy} onClick={() => void decide(e, 'promote', x.label)}>{t('std.promote')}</Button>}</td>
        </tr>)}</tbody></table>
      {e.status === 'awaiting_review' && <Button className="mt-2" size="sm" disabled={busy} onClick={() => void decide(e, 'keep')}>{t('std.keep')}</Button>}
      {e.decision && <p className="mt-2 text-xs text-muted-foreground">{e.decision.by} · {new Date(e.decision.at).toLocaleString()}{e.decision.label ? ` · ${e.decision.label}` : ''}</p>}
    </li>)}</ul>}
  </section>;
}
