import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { workflowBase, workflowRequest } from '@/lib/workflowRuns';

type Change = 'fixed' | 'regressed' | 'still-passing' | 'still-failing' | 'flaky' | 'appeared' | 'disappeared';
interface Row { caseId: string; change: Change; history: string[]; flips: number; failureCode?: string }
interface Compare { baseline: { executionId: string; note: string; at: string }; current: string; between: number; headline: string; cases: Row[] }

/**
 * 和基线比：哪几条修好了、哪几条回归了、哪几条只是在抖。
 *
 * 一次执行只看自己看不出东西。「35 条通过 29」在连续两次里是同一个数字，而**失败的是
 * 不同的六条**——只看总数会把「修好一条又坏一条」读成没变化。所以这里按用例给判决，
 * 并把每条在各次执行里的判决串成一行 P/F，抖不抖一眼能看出来。
 *
 * 这里**不做截图基线**：被测对象是价格每秒都在跳的实时页面，逐步截图基线在它上面每次都红。
 */
const TONE: Record<Change, string> = {
  fixed: 'text-ok', regressed: 'text-bad', flaky: 'text-warn',
  'still-failing': 'text-bad', 'still-passing': 'text-muted-foreground',
  appeared: 'text-muted-foreground', disappeared: 'text-muted-foreground',
};
export function ExecutionCompare({ projectId, runId, executionId }: { projectId: string; runId: string; executionId?: string }) {
  const t = useT();
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `${workflowBase(projectId)}/${runId}/executions`;
  const load = () => {
    setError('');
    void workflowRequest<Compare>(`${base}/compare${executionId ? `?executionId=${executionId}` : ''}`, undefined, 'GET')
      .then(setData).catch(e => { setData(null); setError(String((e as { code?: string }).code ?? 'request_failed')); });
  };
  useEffect(load, [base, executionId]);
  const setBaseline = () => {
    if (!executionId) return;
    setBusy(true);
    void workflowRequest(`${base}/baseline`, { executionId }, 'POST').then(load).finally(() => setBusy(false));
  };
  const shown = (data?.cases ?? []).filter(c => c.change !== 'still-passing');
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label={t('bench.compare.title')}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium">{t('bench.compare.title')}</h3>
      {executionId && <Button size="sm" disabled={busy} onClick={setBaseline}>{t('bench.compare.setBaseline')}</Button>}
    </header>
    {error === 'execution_baseline_missing'
      ? <p className="text-sm text-muted-foreground">{t('bench.compare.noBaseline')}</p>
      : error ? <p role="alert" className="text-sm text-bad">{error}</p>
      : !data ? <p role="status" className="text-sm">{t('workflow.loading')}</p>
      : <>
        <p className="text-sm">{data.headline}</p>
        <p className="text-xs text-muted-foreground">{t('bench.compare.baselineIs')} {data.baseline.executionId.slice(0, 16)}{data.baseline.note && ` · ${data.baseline.note}`}</p>
        {shown.length === 0 ? <p className="text-sm text-ok">{t('bench.compare.allSame')}</p>
          : <ul className="space-y-1 text-xs">{shown.map(c => <li key={c.caseId} className="flex flex-wrap items-center gap-3">
            <span className={`w-24 shrink-0 ${TONE[c.change]}`}>{t(`bench.compare.${c.change}`)}</span>
            <span className="w-36 shrink-0 font-mono">{c.caseId}</span>
            <span className="font-mono tracking-widest">{c.history.map(v => v === 'passed' ? 'P' : v === 'failed' ? 'F' : '·').join('')}</span>
            {c.failureCode && <span className="text-muted-foreground">{c.failureCode}</span>}
          </li>)}</ul>}
      </>}
  </section>;
}
