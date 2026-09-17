import { useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useT } from '@/lib/prefs';
import { API_BASE } from '@/lib/base';
import { navigateProject } from '@/lib/projectContext';
import { PerfSection, VisualSection } from '@/components/RunDetail';
import type { RunRecord, VisualDiff } from '@/lib/types';

type Any = Record<string, any>;
export interface CaseRun {
  caseId: string; title: string; steps: string[]; postSteps: string[];
  status: string; infraError: boolean; failure: Any | null; failureReason: string | null;
  durationMs: number | null; startedAt: string | null; entryUrl: string | null; endedAt: string | null;
  logs: string[]; oracle: Any[]; phases: Record<string, number> | null; perfMetrics: Record<string, number> | null;
  screenshots: string[]; modelCalls: number | null; boardCaseId: string | null;
  run: { id: string; visual: VisualDiff[]; perf: Any | null; tokens: number | null; reportUrl: string | null } | null;
}

const TABS = ['overview', 'timeline', 'oracle', 'visual', 'perf', 'raw'] as const;
type Tab = typeof TABS[number];
const PHASES = ['launchMs', 'loginMs', 'settleMs', 'stepsMs', 'assertMs', 'teardownMs'] as const;
const PHASE_TONE: Record<string, string> = { launchMs: 'bg-muted-foreground/40', loginMs: 'bg-primary/40', settleMs: 'bg-warn/60', stepsMs: 'bg-primary', assertMs: 'bg-ok', teardownMs: 'bg-muted-foreground/70' };
const shot = (ref: string) => `${API_BASE}/api/artifacts/${ref}`;

interface Group { kind: 'prep' | 'step' | 'teardown' | 'assert'; title: string; lines: string[]; shot?: string }

/**
 * 把执行日志切成段：准备 → 第 N 步 → 判定 → 清理。截图按「步骤、清理」的顺序一张对一段——
 * 执行器在每一步（含清理步）之后各截一张。对不上的截图收在最后，不硬塞。
 */
export function groupLogs(logs: string[], screenshots: string[]): { groups: Group[]; leftover: string[] } {
  const groups: Group[] = [];
  let cur: Group = { kind: 'prep', title: '', lines: [] };
  const push = () => { if (cur.lines.length || cur.kind !== 'prep') groups.push(cur); };
  for (const line of logs) {
    const step = /^step (\d+):\s*(.*)$/.exec(line);
    const teardown = /^teardown:\s*(.*)$/.exec(line);
    if (step) { push(); cur = { kind: 'step', title: step[2]!, lines: [] }; continue; }
    if (teardown) { push(); cur = { kind: 'teardown', title: teardown[1]!, lines: [] }; continue; }
    if (/^assert/.test(line) && cur.kind !== 'assert' && !/after step/.test(line)) { push(); cur = { kind: 'assert', title: '', lines: [line] }; continue; }
    cur.lines.push(line);
  }
  push();
  const takers = groups.filter((g) => g.kind === 'step' || g.kind === 'teardown');
  takers.forEach((g, i) => { g.shot = screenshots[i]; });
  return { groups, leftover: screenshots.slice(takers.length) };
}

function Badge({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'good' | 'warn' | 'bad' }) {
  const cls = { plain: 'border-border text-muted-foreground', good: 'border-ok/40 text-ok', warn: 'border-warn/40 text-warn', bad: 'border-bad/40 text-bad' }[tone];
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.6875rem] ${cls}`}>{children}</span>;
}

/**
 * 一条用例的一次执行，分六块：概览、执行过程、判据、视觉基线、性能、原始数据。
 *
 * 过程与截图放在一起，判据与判官理由放在一起，视觉与性能各用各的基线比较——
 * 排查时要回答的是四个不同的问题：做到哪一步了、判的是什么、画面变没变、慢没慢。
 */
export function CaseRunDetail({ item, defaultTab }: { item: CaseRun; defaultTab?: Tab }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(defaultTab ?? (item.status === 'passed' ? 'overview' : 'timeline'));
  const passed = item.status === 'passed';
  const attribution = item.infraError ? 'infra' : String(item.failure?.attribution ?? '');
  const phaseTotal = PHASES.reduce((a, k) => a + (item.phases?.[k] ?? 0), 0);
  const { groups, leftover } = groupLogs(item.logs, item.screenshots);
  const visualDiffs = (item.run?.visual ?? []).filter((v) => v.status === 'diff').length;
  const perfStatus = item.run?.perf?.status as string | undefined;
  const failedChecks = item.oracle.filter((o) => o.status !== 'pass').length;
  const count: Partial<Record<Tab, ReactNode>> = {
    timeline: groups.filter((g) => g.kind === 'step').length,
    oracle: failedChecks ? <span className="text-bad">{failedChecks}</span> : item.oracle.length,
    visual: visualDiffs ? <span className="text-bad">{visualDiffs}</span> : item.run?.visual.length ?? 0,
    perf: perfStatus === 'regression' ? <span className="text-bad">!</span> : undefined,
  };
  const asRecord = { id: item.run?.id ?? '', caseId: item.boardCaseId ?? '', visual: item.run?.visual ?? [], perf: item.run?.perf } as unknown as RunRecord;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={passed ? 'good' : item.infraError ? 'warn' : 'bad'}>{t(`workflow.status.${item.infraError ? 'infra_error' : item.status}`)}</Badge>
      {!passed && attribution && <Badge tone={attribution === 'infra' ? 'warn' : 'bad'}>{t(`report.attribution.${attribution}`)}</Badge>}
      {item.failure?.code && <code className="text-[0.6875rem] text-muted-foreground">{String(item.failure.code)}</code>}
      {typeof item.durationMs === 'number' && <span className="font-mono text-xs text-muted-foreground">{(item.durationMs / 1000).toFixed(1)} s</span>}
      <span className="ml-auto flex flex-wrap gap-2">
        {item.run?.reportUrl
          ? <a className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted" href={`${API_BASE}${item.run.reportUrl}`} target="_blank" rel="noreferrer"><ExternalLink size={12} />{t('runDetail.midsceneReport')}</a>
          : <span className="rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground" title={t('runDetail.noReportWhy')}>{t('runDetail.noReport')}</span>}
        <button className="rounded border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => navigateProject('review', { caseId: item.caseId, revisionId: '', nodeId: '', scope: '' })}>{t('bench.reviewCase')}</button>
      </span>
    </div>

    <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
      {TABS.map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
        className={`-mb-px border-b-2 px-3 py-1.5 text-xs ${tab === k ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
        {t(`runDetail.tab.${k}`)}{count[k] !== undefined && <span className="ml-1 font-mono">{count[k]}</span>}
      </button>)}
    </div>

    {tab === 'overview' && <div className="space-y-4 text-sm">
      {!passed && item.failureReason && <p className="whitespace-pre-wrap break-words rounded border border-bad/30 bg-bad/5 p-3 text-bad">{item.failureReason.split('\n').slice(0, 3).join('\n')}</p>}
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        {item.entryUrl && <><dt className="text-muted-foreground">{t('runDetail.entry')}</dt><dd className="break-all font-mono">{item.entryUrl}</dd></>}
        {item.endedAt && <><dt className="text-muted-foreground">{t('runDetail.endedAt')}</dt><dd className="break-all font-mono">{item.endedAt}</dd></>}
        {item.startedAt && <><dt className="text-muted-foreground">{t('runDetail.startedAt')}</dt><dd className="font-mono">{new Date(item.startedAt).toLocaleString()}</dd></>}
        <dt className="text-muted-foreground">{t('runDetail.modelCalls')}</dt><dd className="font-mono">{item.modelCalls ?? t('workflow.unknown')}</dd>
        <dt className="text-muted-foreground">{t('runDetail.checks')}</dt><dd>{t('runDetail.checksLine', { pass: item.oracle.filter((o) => o.status === 'pass').length, fail: failedChecks, total: item.oracle.length })}</dd>
        <dt className="text-muted-foreground">{t('runs.visualBaseline')}</dt><dd>{item.run ? visualDiffs ? <span className="text-bad">{t('runDetail.visualDiff', { n: visualDiffs })}</span> : t('runDetail.visualOk', { n: item.run.visual.length }) : '—'}</dd>
        <dt className="text-muted-foreground">{t('runs.performance')}</dt><dd>{perfStatus ? t(`runDetail.perf.${perfStatus}`) : '—'}</dd>
      </dl>
      {item.phases && phaseTotal > 0 && <div>
        <p className="mb-1 text-xs text-muted-foreground">{t('runDetail.phases')}</p>
        <div className="flex h-3 w-full overflow-hidden rounded">{PHASES.filter((k) => (item.phases?.[k] ?? 0) > 0).map((k) => <div key={k} title={`${t(`runDetail.phase.${k}`)} ${((item.phases![k] ?? 0) / 1000).toFixed(1)}s`} className={PHASE_TONE[k]} style={{ width: `${((item.phases![k] ?? 0) / phaseTotal) * 100}%` }} />)}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">{PHASES.filter((k) => (item.phases?.[k] ?? 0) > 0).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-2 rounded-sm ${PHASE_TONE[k]}`} />{t(`runDetail.phase.${k}`)} {((item.phases![k] ?? 0) / 1000).toFixed(1)}s</span>)}</div>
      </div>}
    </div>}

    {tab === 'timeline' && <ol className="space-y-3">
      {groups.map((g, i) => <li key={i} className={`rounded-md border p-3 ${g.kind === 'assert' ? 'border-primary/30' : 'border-border'}`}>
        <div className="flex flex-wrap items-baseline gap-2 text-sm">
          <Badge tone={g.kind === 'assert' ? 'good' : 'plain'}>{t(`runDetail.group.${g.kind}`)}{g.kind === 'step' ? ` ${groups.filter((x, j) => x.kind === 'step' && j <= i).length}` : ''}</Badge>
          {g.title && <span className="font-medium">{g.title}</span>}
        </div>
        <div className={`mt-2 grid gap-3 ${g.shot ? 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]' : ''}`}>
          {g.lines.length > 0 ? <ul className="space-y-0.5 font-mono text-[0.6875rem] text-muted-foreground">{g.lines.map((l, k) => <li key={k} className={`whitespace-pre-wrap break-words ${/✗|fail|Error/.test(l) ? 'text-bad' : /✓/.test(l) ? 'text-ok' : /⚠/.test(l) ? 'text-warn' : ''}`}>{l.trim()}</li>)}</ul> : <span />}
          {g.shot && <a href={shot(g.shot)} target="_blank" rel="noreferrer"><img src={shot(g.shot)} loading="lazy" alt={g.title} className="max-h-72 w-full rounded border border-border object-contain object-top" /></a>}
        </div>
      </li>)}
      {leftover.length > 0 && <li className="rounded-md border border-border p-3"><p className="mb-2 text-xs text-muted-foreground">{t('runDetail.otherShots')}</p><div className="grid gap-2 sm:grid-cols-2">{leftover.map((s) => <a key={s} href={shot(s)} target="_blank" rel="noreferrer"><img src={shot(s)} loading="lazy" alt="" className="w-full rounded border border-border" /></a>)}</div></li>}
      {groups.length === 0 && <p className="text-sm text-muted-foreground">{t('runDetail.noLogs')}</p>}
    </ol>}

    {tab === 'oracle' && <ul className="space-y-2">
      {item.oracle.length === 0 && <p className="text-sm text-muted-foreground">{t('runDetail.noChecks')}</p>}
      {item.oracle.map((o, i) => <li key={i} className={`rounded-md border p-3 text-sm ${o.status === 'pass' ? 'border-border' : o.status === 'fail' ? 'border-bad/40' : 'border-warn/40'}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={o.status === 'pass' ? 'good' : o.status === 'fail' ? 'bad' : 'warn'}>{t(`runDetail.check.${o.status}`)}</Badge>
          <Badge tone={o.decidedBy === 'judge' ? 'warn' : 'plain'}>{t(o.decidedBy === 'judge' ? 'regression.byJudge' : 'regression.byMachine')}</Badge>
          {o.heldBefore && <Badge tone="warn">{t('runDetail.heldBefore')}</Badge>}
        </div>
        <p className="mt-1.5">{String(o.assertion ?? '')}</p>
        {o.detail && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{String(o.detail)}</p>}
        {o.judge && <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
          <Badge>{t('judge.samples', { passed: Number(o.judge.passed), samples: Number(o.judge.samples), min: Number(o.judge.minPass) })}</Badge>
          {o.judge.split && <Badge tone="warn">{t('judge.split')}</Badge>}
          {Number(o.judge.valid) < Number(o.judge.samples) && <Badge tone="warn">{t('judge.invalid', { n: Number(o.judge.samples) - Number(o.judge.valid) })}</Badge>}
        </p>}
      </li>)}
    </ul>}

    {tab === 'visual' && (item.run ? <div className="space-y-3">
      <VisualSection run={asRecord} />
      {item.run.visual.length > 0 && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{item.run.visual.map((v) => <figure key={v.stepIdx} className="rounded border border-border p-1.5">
        {v.currentRef ? <img src={shot(v.currentRef)} loading="lazy" alt="" className="aspect-video w-full rounded object-cover object-top" /> : <div className="aspect-video rounded bg-muted" />}
        <figcaption className="mt-1 flex items-center justify-between text-[0.6875rem]"><span>{t('runs.step')} {v.stepIdx + 1}</span><span className={v.status === 'diff' ? 'text-bad' : v.status === 'match' ? 'text-ok' : 'text-muted-foreground'}>{t(`runDetail.visual.${v.status}`)}{v.status === 'diff' ? ` · ${v.mismatchPct.toFixed(2)}%` : ''}</span></figcaption>
      </figure>)}</div>}
    </div> : <p className="text-sm text-muted-foreground">{t('runDetail.noRunRecord')}</p>)}

    {tab === 'perf' && <div className="space-y-2">
      {item.run?.perf ? <PerfSection run={asRecord} /> : item.perfMetrics ? <table className="w-full text-xs"><tbody>{Object.entries(item.perfMetrics).map(([k, v]) => <tr key={k}><td className="py-0.5 text-muted-foreground">{k}</td><td className="py-0.5 text-right font-mono">{v}ms</td></tr>)}</tbody></table> : <p className="text-sm text-muted-foreground">{t('runDetail.noPerf')}</p>}
      <p className="text-xs text-muted-foreground">{t('runDetail.perfHint')}</p>
    </div>}

    {tab === 'raw' && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{JSON.stringify(item, null, 2)}</pre>}
  </div>;
}
