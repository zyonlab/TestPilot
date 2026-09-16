import type { ReactNode } from 'react';
import { useT } from '@/lib/prefs';
import { hasKey } from '@/lib/i18n';
import { describeOracle, tierDelivered } from '@/lib/artifact/oracle';
import { METHOD_KEY } from '@/lib/artifact/types';
import type { MachineOracle } from '@/lib/artifact/types';

type Any = Record<string, any>;
export interface CaseStory { id: string; title?: string; acceptance?: string[] }
export interface CaseFinding { rule: string; severity: string; message: string; caseId?: string; args?: Record<string, string | number> }

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const isOpenQuestion = (s: string) => /待确认|不作为失败判据|open question/i.test(s);

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return <section className="space-y-2">
    <h4 className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">{title}{hint && <span className="font-normal">{hint}</span>}</h4>
    <div className="text-sm">{children}</div>
  </section>;
}
function Tag({ children, tone = 'plain', title }: { children: ReactNode; tone?: 'plain' | 'good' | 'warn' | 'bad'; title?: string }) {
  const cls = { plain: 'border-border text-muted-foreground', good: 'border-ok/40 text-ok', warn: 'border-warn/40 text-warn', bad: 'border-bad/40 text-bad' }[tone];
  return <span title={title} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.6875rem] ${cls}`}>{children}</span>;
}

/**
 * 一条文本用例的完整详情，按评审的阅读顺序：
 * 为什么测 → 覆盖什么 → 前提与数据 → 步骤与判定（断言挂在它该判的那一步后面）→ 清理 → 设计依据 → 就绪度 → 出处 → 门禁意见。
 *
 * 此前复核页只画标题、前置、步骤、预期，判据是一段原始 JSON；而一条用例二十多个字段里，
 * 决定它值不值得签字的恰恰是没画出来的那些：它为什么重要、覆盖哪条验收准则、每条断言由谁判、
 * 挂在第几步之后判、设计依据是哪一类、能不能直接执行。
 */
export function TextCaseDetail({ kase, stories = [], findings = [] }: { kase: Any; stories?: CaseStory[]; findings?: CaseFinding[] }) {
  const t = useT();
  const steps = arr(kase.steps);
  const assertions: Any[] = Array.isArray(kase.assertions) ? kase.assertions : [];
  const oracles = [kase.oracle, ...assertions.map((a) => a.oracle)].filter(Boolean) as MachineOracle[];
  const machine = oracles.filter((o) => o.kind !== 'judge' && (o as { kind: string }).kind !== 'none');
  const delivered = machine.length ? Math.min(...machine.map(tierDelivered)) : 3;
  const claimed = Number(kase.tier ?? 3);
  const risk = kase.risk as Any | undefined;
  const readiness = kase.readiness as Any | undefined;
  const design = kase.design as Any | undefined;
  const testData: Any[] = Array.isArray(kase.testData?.values) ? kase.testData.values : [];

  const acText = (ref: string) => {
    const m = /^(.*)\/AC-(\d+)$/.exec(ref);
    if (!m) return undefined;
    return stories.find((s) => s.id === m[1])?.acceptance?.[Number(m[2]) - 1];
  };
  const oracleText = (o?: MachineOracle) => !o ? '' : (o as { kind: string }).kind === 'none' ? t('caseDetail.byModel') : describeOracle(o, t);
  const verdictTag = (o?: MachineOracle, statement = '') => {
    if (isOpenQuestion(statement)) return <Tag tone="warn">{t('caseDetail.openQuestion')}</Tag>;
    if (!o || (o as { kind: string }).kind === 'none') return <Tag tone="warn">{t('caseDetail.judgeByModel')}</Tag>;
    if (o.kind === 'judge') return <Tag tone="warn">{t('caseDetail.judgeSampled')}</Tag>;
    return <Tag tone="good">{t('caseDetail.byProgram', { tier: tierDelivered(o) })}</Tag>;
  };
  const assertionRow = (a: Any, i: number) => <li key={a.id ?? i} className="rounded border border-border bg-muted/30 p-2">
    <div className="flex flex-wrap items-center gap-1.5">{verdictTag(a.oracle, String(a.statement ?? ''))}{a.id && <span className="font-mono text-[0.6875rem] text-muted-foreground">{a.id}</span>}{arr(a.ruleRefs).map((r) => <Tag key={r}>{r}</Tag>)}</div>
    <p className="mt-1">{String(a.statement ?? '')}</p>
    {a.oracle && (a.oracle as { kind: string }).kind !== 'none' && <p className="mt-1 break-words font-mono text-[0.75rem] text-ok">{oracleText(a.oracle)}</p>}
  </li>;
  const stepBound = (n: number) => assertions.filter((a) => Number(a.afterStep) === n);
  const finalAssertions = assertions.filter((a) => !(Number(a.afterStep) >= 1 && Number(a.afterStep) <= steps.length));
  const designLabel = (k: string) => hasKey(`caseDetail.design.${k}`) ? t(`caseDetail.design.${k}`) : k;
  const designValue = (k: string, v: unknown): ReactNode => {
    if (k === 'points' && Array.isArray(v)) return v.map((p: Any, i) => <Tag key={i}>{t(`caseDetail.point.${p.at}`)} {String(p.value)}</Tag>);
    if (k === 'assignment' && v && typeof v === 'object') return <ul className="space-y-0.5">{Object.entries(v).map(([c, x]) => <li key={c}><span className="font-mono text-[0.6875rem] text-muted-foreground">{c}</span> = {String(x)}</li>)}</ul>;
    if (Array.isArray(v)) return v.map((x) => <Tag key={String(x)}>{String(x)}</Tag>);
    if (k === 'technique') return t(METHOD_KEY[String(v)] ?? 'artifact.method.unknown');
    if ((k === 'validity' || k === 'inclusivity') && hasKey(`caseDetail.value.${String(v)}`)) return t(`caseDetail.value.${String(v)}`);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  // 门禁文案有译文就用译文；译文里还剩没填上的占位符（老数据没带参数），退回领域层的原句。
  const gateText = (f: CaseFinding) => {
    if (!hasKey(`gate.${f.rule}.msg`)) return f.message;
    const text = t(`gate.${f.rule}.msg`, f.args ?? {});
    return /\{\w+\}/.test(text) ? f.message : text;
  };
  const refGroups: Array<[string, string[]]> = [
    ['features', arr(kase.featureRefs)], ['rules', arr(kase.ruleRefs)], ['conditions', arr(kase.conditionRefs)], ['transitions', arr(kase.covers)],
  ];

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs text-muted-foreground">{String(kase.id ?? '')}</span>
      {kase.priority && <Tag tone={kase.priority === 'P0' ? 'bad' : kase.priority === 'P1' ? 'warn' : 'plain'}>{kase.priority}</Tag>}
      <Tag tone={claimed < delivered ? 'warn' : 'plain'} title={claimed < delivered ? t('artifact.tierMismatch', { claimed, delivered }) : undefined}>{t('caseDetail.tier', { tier: claimed })}{claimed < delivered ? ` → ${delivered}` : ''}</Tag>
      {kase.designMethod && <Tag>{t(METHOD_KEY[String(kase.designMethod)] ?? 'artifact.method.unknown')}</Tag>}
      {kase.scenarioType && <Tag tone={kase.scenarioType === 'negative' ? 'warn' : 'plain'}>{hasKey(`caseDetail.scenario.${kase.scenarioType}`) ? t(`caseDetail.scenario.${kase.scenarioType}`) : String(kase.scenarioType)}</Tag>}
      {risk?.impact && <Tag tone="bad">{hasKey(`caseDetail.impact.${risk.impact}`) ? t(`caseDetail.impact.${risk.impact}`) : String(risk.impact)}</Tag>}
      {readiness?.execution && <Tag tone={readiness.execution === 'ready' ? 'good' : 'warn'}>{hasKey(`caseDetail.readiness.${readiness.execution}`) ? t(`caseDetail.readiness.${readiness.execution}`) : String(readiness.execution)}</Tag>}
      {kase.storyId && <Tag>{String(kase.storyId)}</Tag>}
    </div>

    {risk?.reason && <Section title={t('caseDetail.why')}><p>{String(risk.reason)}</p></Section>}

    {(arr(kase.acRefs).length > 0 || refGroups.some(([, v]) => v.length)) && <Section title={t('caseDetail.covers')}>
      {arr(kase.acRefs).length > 0 && <ul className="space-y-1">{arr(kase.acRefs).map((r) => <li key={r} className="rounded border border-border p-2"><span className="font-mono text-[0.6875rem] text-muted-foreground">{r}</span>{acText(r) && <p className="mt-0.5">{acText(r)}</p>}</li>)}</ul>}
      <div className="mt-2 space-y-1">{refGroups.filter(([, v]) => v.length).map(([k, v]) => <div key={k} className="flex flex-wrap items-center gap-1.5"><span className="w-14 shrink-0 text-xs text-muted-foreground">{t(`caseDetail.ref.${k}`)}</span>{v.map((x) => <Tag key={x}>{x}</Tag>)}</div>)}</div>
    </Section>}

    <div className="grid gap-5 md:grid-cols-2">
      <Section title={t('bench.precondition')}>{arr(kase.precondition).length ? <ul className="list-disc space-y-1 pl-5">{arr(kase.precondition).map((p, i) => <li key={i}>{p}</li>)}</ul> : <p className="text-muted-foreground">{t('artifact.noPrecondition')}</p>}</Section>
      <Section title={t('bench.testData')}>{testData.length ? <table className="w-full text-xs"><tbody>{testData.map((d, i) => <tr key={i} className="border-b border-border last:border-0"><td className="py-1 pr-2 text-muted-foreground">{String(d.name ?? '')}</td><td className="py-1 pr-2 font-mono">{String(d.value ?? '')}{d.unit ? ` ${d.unit}` : ''}</td><td className="py-1 text-right font-mono text-[0.6875rem] text-muted-foreground">{String(d.source ?? '')}</td></tr>)}</tbody></table> : <p className="text-muted-foreground">{t('artifact.noData')}</p>}</Section>
    </div>

    <Section title={t('caseDetail.stepsAndChecks')}>
      <ol className="space-y-2">{steps.map((s, i) => <li key={i} className="flex gap-3">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[0.6875rem]">{i + 1}</span>
        <div className="min-w-0 flex-1 space-y-1.5"><p className="break-words">{s}</p>{stepBound(i + 1).length > 0 && <ul className="space-y-1.5">{stepBound(i + 1).map(assertionRow)}</ul>}</div>
      </li>)}</ol>
      <div className="mt-3 space-y-2 rounded-md border border-primary/30 p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('caseDetail.finalCheck')}</p>
        <div className="flex flex-wrap items-center gap-1.5">{verdictTag(kase.oracle, String(kase.expected ?? ''))}<span>{String(kase.expected ?? '')}</span></div>
        {kase.oracle && (kase.oracle as { kind: string }).kind !== 'none' && <p className="break-words font-mono text-[0.75rem] text-ok">{oracleText(kase.oracle)}</p>}
        {finalAssertions.length > 0 && <ul className="space-y-1.5">{finalAssertions.map(assertionRow)}</ul>}
      </div>
    </Section>

    {arr(kase.postSteps).length > 0 && <Section title={t('bench.cleanup')}><ol className="list-decimal space-y-1 pl-5">{arr(kase.postSteps).map((s, i) => <li key={i}>{s}</li>)}</ol></Section>}

    {design && <Section title={t('bench.designEvidence')}>
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">{Object.entries(design).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{designLabel(k)}</dt><dd className="flex flex-wrap gap-1 break-words">{designValue(k, v)}</dd></div>)}</dl>
    </Section>}

    {readiness && <Section title={t('caseDetail.readinessTitle')}>
      <p className="text-xs text-muted-foreground">{t('caseDetail.readinessLine', { design: String(readiness.design ?? '—'), execution: hasKey(`caseDetail.readiness.${readiness.execution}`) ? t(`caseDetail.readiness.${readiness.execution}`) : String(readiness.execution ?? '—') })}</p>
      {readiness.reason && <p className="mt-1">{String(readiness.reason)}</p>}
    </Section>}

    {arr(kase.sourceRefs).length > 0 && <Section title={t('caseDetail.sources')}><div className="flex flex-wrap gap-1.5">{arr(kase.sourceRefs).map((s) => <Tag key={s}>{s}</Tag>)}</div></Section>}

    {findings.length > 0 && <Section title={t('caseDetail.gateFindings', { n: findings.length })}>
      <ul className="space-y-1">{findings.map((f, i) => <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs"><Tag tone={f.severity === 'error' ? 'bad' : f.severity === 'warn' ? 'warn' : 'plain'}>{f.severity}</Tag><code className="text-muted-foreground">{f.rule}</code><span>{gateText(f)}</span></li>)}</ul>
    </Section>}

    <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t('caseDetail.raw')}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3">{JSON.stringify(kase, null, 2)}</pre></details>
  </div>;
}
