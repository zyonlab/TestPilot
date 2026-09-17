import { memo, useMemo } from 'react';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { AlertCircle, CheckCircle2, Circle, FileText, Loader2 } from 'lucide-react';
import { useT } from '@/lib/prefs';
import { navigateProject } from '@/lib/projectContext';
import type { Revision, WorkflowRun } from '@/lib/workflowRuns';
import { FlowCanvas } from './FlowCanvas';

type Phase = 'done' | 'stopped' | 'running' | 'untouched' | 'queued';
interface StageData extends Record<string, unknown> {
  stage: string; label: string; phase: string; state: Phase; message?: string;
  artifacts: Revision[]; breakpoint: boolean; canBreak: boolean; busy: boolean;
  onToggleBreakpoint: (stage: string) => void;
}

const RAIL: Record<Phase, string> = { done: 'bg-ok', stopped: 'bg-bad', running: 'bg-primary', untouched: 'bg-border', queued: 'bg-border' };
const TEXT: Record<Phase, string> = { done: 'text-ok', stopped: 'text-bad', running: 'text-primary', untouched: 'text-muted-foreground', queued: 'text-muted-foreground' };
const NODE_W = 236, GAP = 64, ROW_GAP = 340, PER_ROW = 4;
/** 蛇形排布：偶数行从左到右，奇数行从右到左，行尾向下拐到下一行的行首。 */
const slot = (i: number) => {
  const row = Math.floor(i / PER_ROW), col = i % PER_ROW;
  return { row, x: (row % 2 ? PER_ROW - 1 - col : col) * (NODE_W + GAP), y: row * ROW_GAP };
};
const hidden = '!h-2 !w-2 !border-0 !bg-transparent';

const StageNode = memo(function StageNode({ data }: NodeProps<Node<StageData>>) {
  const t = useT();
  const Icon = data.state === 'done' ? CheckCircle2 : data.state === 'stopped' ? AlertCircle : data.state === 'running' ? Loader2 : Circle;
  const artifactLabel = (r: Revision) => r.kind === 'execution' ? t('surface.runs') : r.kind === 'code' ? t('workflow.kind.code') : r.name.startsWith('validated/') ? data.label : r.name;
  return <div style={{ width: NODE_W }} className="group">
    <Handle id="tl" type="target" position={Position.Left} style={{ top: 38 }} className={hidden} isConnectable={false} />
    <Handle id="tr" type="target" position={Position.Right} style={{ top: 38 }} className={hidden} isConnectable={false} />
    <Handle id="tt" type="target" position={Position.Top} className={hidden} isConnectable={false} />
    <div className={`relative overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow group-hover:shadow-md ${data.state === 'stopped' ? 'border-bad/40' : data.state === 'running' ? 'border-primary/50' : 'border-border'}`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${RAIL[data.state]}`} />
      <button type="button" aria-pressed={data.breakpoint} disabled={!data.canBreak || data.busy}
        aria-label={`${t('bench.breakpoint')} · ${data.label}`}
        title={t(data.stage === 'review' ? 'bench.manualReviewStop' : data.canBreak ? 'bench.breakpoint' : 'bench.breakpointDisabled')}
        onClick={() => data.onToggleBreakpoint(data.stage)}
        className={`nodrag absolute right-2.5 top-2.5 h-3.5 w-3.5 rounded-full border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${data.breakpoint ? 'border-bad bg-bad' : 'border-border hover:border-bad/60'}`} />
      <button type="button" className="nodrag block w-full py-3 pl-4 pr-8 text-left" onClick={() => navigateProject('canvas', { nodeId: data.stage, revisionId: '' })}>
        <span className="block text-[0.9375rem] font-semibold leading-tight">{data.label}</span>
        <span className="mt-1 block font-mono text-[0.6875rem] text-muted-foreground">{data.stage}</span>
        <span className={`mt-2 inline-flex items-center gap-1 text-xs ${TEXT[data.state]}`}><Icon size={12} className={data.state === 'running' ? 'animate-spin' : ''} />{t(`workflow.status.${data.phase}`)}</span>
      </button>
      {data.message && <p className={`mx-4 mb-3 line-clamp-3 text-[0.6875rem] leading-snug ${data.state === 'stopped' ? 'text-bad' : 'text-muted-foreground'}`} title={data.message}>{data.message}</p>}
      {data.artifacts.length > 0 && <div className="nowheel max-h-40 space-y-0.5 overflow-auto border-t border-border bg-muted/30 p-1.5">
        {[...data.artifacts].reverse().map((r) => <button type="button" key={r.id} className="nodrag flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-card"
          onClick={() => navigateProject('canvas', { revisionId: r.id, nodeId: data.stage })}>
          <FileText size={13} className="mt-0.5 shrink-0 text-primary" />
          <span className="min-w-0 break-words leading-snug">{artifactLabel(r)}<span className="block text-[0.625rem] text-muted-foreground">{['execution', 'code'].includes(r.kind) ? new Date(r.createdAt).toLocaleTimeString() : `v${r.revision}`}</span></span>
        </button>)}
      </div>}
    </div>
    <Handle id="sr" type="source" position={Position.Right} style={{ top: 38 }} className={hidden} isConnectable={false} />
    <Handle id="sl" type="source" position={Position.Left} style={{ top: 38 }} className={hidden} isConnectable={false} />
    <Handle id="sb" type="source" position={Position.Bottom} className={hidden} isConnectable={false} />
  </div>;
});

const nodeTypes = { stage: StageNode };

/**
 * 一次运行的节点流程图。数据与交互照旧：点节点看节点详情，点产物打开那一版，圆点是断点开关。
 * 连线表达的是「走到哪了」：走过的是绿色，正在跑的那一段在流动，没走到的是灰色。
 */
export function StageFlow({ run, stages, breakpoints, busy, nodeRevisions, onToggleBreakpoint }: {
  run: WorkflowRun; stages: string[]; breakpoints: string[]; busy: boolean;
  nodeRevisions: (stage: string, revisions: Revision[]) => Revision[];
  onToggleBreakpoint: (stage: string) => void;
}) {
  const t = useT();
  const sourceKind = run.detail?.parameters?.sourceKind ?? 'spec';
  const { nodes, edges } = useMemo(() => {
    const states: Phase[] = [];
    const nodes: Node<StageData>[] = stages.map((stage, i) => {
      const event = [...run.nodes].reverse().find((n) => n.node === stage);
      const artifacts = nodeRevisions(stage, run.revisions);
      const phase = stage === 'source' ? (event?.phase ?? (run.binding?.inputHash ? 'done' : 'queued')) : event?.phase ?? 'queued';
      const done = ['done', 'completed', 'passed'].includes(phase);
      const stopped = ['paused', 'blocked', 'failed', 'infra_error', 'waiting_review'].includes(phase) && !done;
      const untouched = stage !== 'review' && !event && !artifacts.length && phase === 'queued';
      const state: Phase = done ? 'done' : stopped ? 'stopped' : phase === 'running' ? 'running' : untouched ? 'untouched' : 'queued';
      states.push(state);
      return {
        id: stage, type: 'stage', position: { x: slot(i).x, y: slot(i).y },
        data: { stage, label: t(stage === 'source' ? `bench.source.${sourceKind}` : `workflow.stage.${stage}`), phase, state, message: event?.message,
          artifacts, breakpoint: breakpoints.includes(stage), canBreak: untouched, busy, onToggleBreakpoint },
      };
    });
    const edges: Edge[] = stages.slice(1).map((stage, i) => {
      const from = states[i]!, to = states[i + 1]!;
      const color = from === 'done' ? 'hsl(var(--ok))' : to === 'running' ? 'hsl(var(--primary))' : 'hsl(var(--border))';
      const a = slot(i), b = slot(i + 1);
      // 同一行：顺着这一行的方向连；换行：从上一行末尾的底部连到下一行开头的顶部。
      const handles = a.row !== b.row ? { sourceHandle: 'sb', targetHandle: 'tt' }
        : a.row % 2 ? { sourceHandle: 'sl', targetHandle: 'tr' } : { sourceHandle: 'sr', targetHandle: 'tl' };
      return { id: `${stages[i]}-${stage}`, source: stages[i]!, target: stage, ...handles, type: 'smoothstep', animated: to === 'running',
        style: { stroke: color, strokeWidth: from === 'done' ? 2 : 1.5 } };
    });
    return { nodes, edges };
  }, [run, stages, breakpoints, busy, nodeRevisions, onToggleBreakpoint, t, sourceKind]);
  return <FlowCanvas nodes={nodes} edges={edges} nodeTypes={nodeTypes} height="100%" layoutKey={run.id} minZoom={0.35} maxZoom={1} ariaLabel={t('bench.title')} />;
}
