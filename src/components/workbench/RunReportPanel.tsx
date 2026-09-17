import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { workflowBase, workflowRequest } from '@/lib/workflowRuns';

type Layer = 'model' | 'context' | 'tool' | 'workflow' | 'case' | 'product';
interface Signal { layer: Layer; alternatives?: Layer[]; level: 'problem' | 'watch'; code: string; message: string; evidence: Record<string, unknown> }
type Node = Record<string, unknown> & { 有产物: boolean; 说明?: string };
interface Report {
  nodes4: Record<'产品结构' | '用户故事' | '文本用例' | '用例代码', Node>;
  units: { enabled: boolean; summary: Record<string, number>; maxAttempt: number } | null;
  host: { turns: number; duplicateLines: number; cacheReadTokens: number; cacheReadMedian: number; cacheReadPeak: number; toolErrors: number; reportedUsd: number | null; completed: boolean } | null;
  execution: { executionId: string; status: string; cases: number; byAttribution: Record<string, number>; comparison: Record<string, number> | null } | null;
  layers: Array<{ layer: Layer; score: number; problems: number; watches: number }>;
  signals: Signal[];
}

/**
 * 一跑的节点数据由服务端按中文键给出（`server/src/runReport.ts`）；这里挑每个节点最该看的几个，
 * 名字走 i18n，完整数据放在折叠里。
 */
const NODES: Array<{ key: keyof Report['nodes4']; id: string; metrics: Array<{ key: string; id: string; pct?: boolean }> }> = [
  { key: '产品结构', id: 'structure', metrics: [{ key: '模块', id: 'modules' }, { key: '叶子', id: 'leaves' }, { key: '功能', id: 'features' }, { key: '未认领', id: 'unclaimed' }, { key: '角色', id: 'roles' }, { key: '机检发现', id: 'findings' }] },
  { key: '用户故事', id: 'stories', metrics: [{ key: '故事', id: 'stories' }, { key: '验收准则', id: 'criteria' }, { key: '动作型占比', id: 'actionable', pct: true }, { key: '空叶子', id: 'emptyLeaves' }, { key: '出处覆盖率', id: 'citations', pct: true }, { key: '机检发现', id: 'findings' }] },
  { key: '文本用例', id: 'cases', metrics: [{ key: '用例', id: 'cases' }, { key: '门禁分', id: 'gateScore' }, { key: '过没过', id: 'gatePassed' }, { key: '被扣分的用例', id: 'flagged' }, { key: '负例比', id: 'negativeRatio' }, { key: '机检发现', id: 'findings' }] },
  { key: '用例代码', id: 'code', metrics: [{ key: '有代码的用例', id: 'withCode' }, { key: '编译失败', id: 'compileFailed' }, { key: '代码行数中位', id: 'linesMedian' }, { key: '自愈轮次', id: 'repairRounds' }, { key: '被降级的用例', id: 'degraded' }] },
];

const LEVEL_TONE = { problem: 'border-bad/40 text-bad', watch: 'border-warn/40 text-warn' } as const;

/**
 * 归因报表：问题更可能出在哪一层。
 *
 * 规则是固定的（服务端写死、有单测），每条结论都带着触发它的数——看的人要能一眼判断它凭什么这么说，
 * 不同意就去改规则，而不是换个问法再问一遍。
 */
export function RunReportPanel({ projectId, runId, status }: { projectId: string; runId: string; status: string }) {
  const t = useT();
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await workflowRequest<Report>(`${workflowBase(projectId)}/${encodeURIComponent(runId)}/report`, undefined, 'GET', signal);
      if (!signal?.aborted) { setReport(data); setFailed(false); }
    } catch { if (!signal?.aborted) setFailed(true); } finally { if (!signal?.aborted) setLoading(false); }
  }, [projectId, runId]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load, status]);

  const layer = (l: Layer) => t(`report.layer.${l}`);
  const value = (v: unknown, pct?: boolean) => v === undefined || v === null ? '—' : typeof v === 'boolean' ? t(v ? 'report.yes' : 'report.no') : pct ? `${v}%` : typeof v === 'number' ? v.toLocaleString() : String(v);

  return <section className="space-y-4 rounded-lg border border-border p-4" aria-label={t('report.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">{t('report.title')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('report.help')}</p></div>
      <Button size="sm" disabled={loading} onClick={() => void load()}>{t('workflow.refresh')}</Button>
    </div>
    {failed ? <p role="status" className="text-sm text-bad">{t('workflow.connectionError')}</p> : !report ? <p role="status" className="text-sm text-muted-foreground">{t('workflow.loading')}</p> : <>
      <div className="flex flex-wrap gap-2" aria-label={t('report.layers')}>
        {report.layers.length === 0 && <span className="text-sm text-ok">{t('report.noSignals')}</span>}
        {report.layers.map((l, i) => <span key={l.layer} className={`rounded border px-2 py-1 text-xs ${i === 0 ? 'border-primary/50 font-medium' : 'border-border'}`}>
          {layer(l.layer)} · {l.score}<span className="ml-1 text-muted-foreground">({t('report.counts', { p: l.problems, w: l.watches })})</span>
        </span>)}
      </div>

      {report.signals.length > 0 && <ul className="space-y-2">
        {[...report.signals].sort((a, b) => Number(a.level === 'watch') - Number(b.level === 'watch')).map((s, i) => <li key={`${s.code}-${i}`} className="rounded border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 text-[0.6875rem] ${LEVEL_TONE[s.level]}`}>{t(`report.level.${s.level}`)}</span>
            <span className="font-medium">{layer(s.layer)}</span>
            {s.alternatives?.length ? <span className="text-xs text-muted-foreground">{t('report.alsoMaybe', { layers: s.alternatives.map(layer).join(' / ') })}</span> : null}
            <code className="ml-auto text-[0.6875rem] text-muted-foreground">{s.code}</code>
          </div>
          <p className="mt-2 break-words">{s.message}</p>
          {Object.keys(s.evidence).length > 0 && <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">{t('report.evidence')}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify(s.evidence, null, 2)}</pre></details>}
        </li>)}
      </ul>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {NODES.map((n) => { const node = report.nodes4[n.key]; return <div key={n.id} className="rounded border border-border p-3 text-xs">
          <h4 className="mb-2 text-sm font-medium">{t(`report.node.${n.id}`)}</h4>
          {!node?.有产物 ? <p className="text-muted-foreground">{t('report.noArtifact')}</p> : <>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">{n.metrics.map((m) => <div key={m.id} className="contents"><dt className="text-muted-foreground">{t(`report.metric.${m.id}`)}</dt><dd className="text-right font-mono">{value(node[m.key], m.pct)}</dd></div>)}</dl>
            <details className="mt-2"><summary className="cursor-pointer text-muted-foreground">{t('report.allMetrics')}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify(node, null, 2)}</pre></details>
          </>}
        </div>; })}
      </div>

      <div className="grid gap-3 md:grid-cols-3 text-xs">
        {report.units?.enabled && <div className="rounded border border-border p-3"><h4 className="mb-2 text-sm font-medium">{t('report.units')}</h4><p className="font-mono">{t('report.unitsLine', { done: report.units.summary.done ?? 0, total: report.units.summary.total ?? 0, failed: report.units.summary.failed ?? 0, max: report.units.maxAttempt })}</p></div>}
        {report.host && <div className="rounded border border-border p-3"><h4 className="mb-2 text-sm font-medium">{t('report.host')}</h4>
          <p className="font-mono">{t('report.hostLine', { turns: report.host.turns, peak: report.host.cacheReadPeak.toLocaleString(), median: report.host.cacheReadMedian.toLocaleString() })}</p>
          <p className="mt-1 text-muted-foreground">{t('report.hostErrors', { n: report.host.toolErrors })} · {report.host.reportedUsd === null ? t('workflow.unknown') : `$${report.host.reportedUsd.toFixed(2)}`}{report.host.completed ? '' : ` · ${t('report.hostIncomplete')}`}</p>
          <p className="mt-1 text-muted-foreground">{t('report.hostDedup', { n: report.host.duplicateLines })}</p>
        </div>}
        {report.execution && <div className="rounded border border-border p-3"><h4 className="mb-2 text-sm font-medium">{t('report.execution')}</h4>
          <div className="flex flex-wrap gap-1.5">{Object.entries(report.execution.byAttribution).map(([k, n]) => <span key={k} className="rounded border border-border px-1.5 py-0.5">{t(`report.attribution.${k}`)} · {n}</span>)}{Object.keys(report.execution.byAttribution).length === 0 && <span className="text-ok">{t('report.allPassed')}</span>}</div>
          <p className="mt-1 text-muted-foreground">{report.execution.comparison ? t('report.withBaseline') : t('report.noBaseline')}</p>
        </div>}
      </div>
    </>}
  </section>;
}
