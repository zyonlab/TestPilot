import { memo, useMemo } from 'react';
import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Boxes } from 'lucide-react';
import { useT } from '@/lib/prefs';
import { FlowCanvas } from './FlowCanvas';

type Item = Record<string, unknown>;
interface ModuleData extends Record<string, unknown> {
  id: string; name: string; root: boolean; selected: boolean; leaf: boolean;
  stories?: number; subtitle?: string; outOfScope: boolean;
  onSelect: (id: string) => void;
}

const COL_W = 280, NODE_W = 196, ROW_H = 64;

const ModuleNode = memo(function ModuleNode({ data }: NodeProps<Node<ModuleData>>) {
  const t = useT();
  const tone = data.selected ? 'border-primary bg-primary/10 text-primary shadow-sm'
    : data.root ? 'border-primary/30 bg-primary/5 text-primary'
    : data.outOfScope ? 'border-dashed border-border bg-card text-muted-foreground'
    : 'border-border bg-card hover:border-primary/60';
  return <div style={{ width: NODE_W }}>
    {!data.root && <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" isConnectable={false} />}
    <button type="button" aria-pressed={data.selected} onClick={() => data.onSelect(data.id)}
      className={`nodrag flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${tone}`}>
      {data.root && <Boxes size={15} className="shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[0.8125rem] ${data.leaf ? '' : 'font-medium'}`} title={data.name}>{data.name}</span>
        {data.subtitle && <span className="block truncate text-[0.6875rem] text-muted-foreground">{data.subtitle}</span>}
      </span>
      {data.stories !== undefined && <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6875rem] ${data.stories ? 'bg-muted text-foreground' : 'bg-warn/10 text-warn'}`} title={t('workflow.stage.stories')}>{data.stories}</span>}
    </button>
    <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" isConnectable={false} />
  </div>;
});
const nodeTypes = { module: ModuleNode };

/**
 * 模块树的流程图：从左到右，父节点竖直居中于它的子节点。
 * 布局是算出来的（叶子依次占一行，父节点取子节点行号的中点），不靠拖——树改了图跟着变。
 */
export function ModuleFlow({ modules, selected, onSelect, storyCount, rootSubtitle }: {
  modules: Item[]; selected: string; onSelect: (id: string) => void;
  /** 不给就不显示故事数（modules 节点时还没有故事，写 0 像是漏了）。 */
  storyCount?: (moduleId: string) => number;
  rootSubtitle: string;
}) {
  const t = useT();
  const { nodes, edges, rows } = useMemo(() => {
    const ids = new Set(modules.map((m) => String(m.id)));
    const children = (parent: string) => modules.filter((m) => {
      const p = String(m.parentId ?? '');
      return parent === '' ? !p || !ids.has(p) : p === parent;
    });
    const nodes: Node<ModuleData>[] = [];
    const edges: Edge[] = [];
    let row = 0;
    const place = (m: Item, depth: number, guard: number): number => {
      const id = String(m.id);
      const kids = guard > 12 ? [] : children(id);
      const y = kids.length
        ? (() => { const ys = kids.map((k) => place(k, depth + 1, guard + 1)); return (Math.min(...ys) + Math.max(...ys)) / 2; })()
        : row++ * ROW_H;
      for (const k of kids) edges.push({ id: `${id}-${String(k.id)}`, source: id, target: String(k.id), type: 'default',
        style: { stroke: selected && (selected === id || selected === String(k.id)) ? 'hsl(var(--primary))' : 'hsl(var(--border))', strokeWidth: 1.25 } });
      nodes.push({ id, type: 'module', position: { x: depth * COL_W, y }, data: {
        id, name: String(m.name ?? m.id), root: false, leaf: !kids.length, selected: selected === id,
        stories: storyCount?.(id), subtitle: kids.length ? t('flow.children', { n: kids.length }) : undefined,
        outOfScope: !!m.outOfScope, onSelect: (x) => onSelect(selected === x ? '' : x) } });
      return y;
    };
    const tops = children('');
    const ys = tops.map((m) => place(m, 1, 0));
    const rootY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    nodes.push({ id: '__all__', type: 'module', position: { x: 0, y: rootY }, data: {
      id: '', name: t('bench.allModules'), root: true, leaf: false, selected: !selected, subtitle: rootSubtitle,
      outOfScope: false, onSelect: () => onSelect('') } });
    for (const m of tops) edges.push({ id: `root-${String(m.id)}`, source: '__all__', target: String(m.id), type: 'default',
      style: { stroke: 'hsl(var(--primary) / 0.35)', strokeWidth: 1.25 } });
    return { nodes, edges, rows: row };
  }, [modules, selected, onSelect, storyCount, rootSubtitle, t]);
  const height = Math.min(460, Math.max(220, rows * ROW_H + 72));
  return <FlowCanvas nodes={nodes} edges={edges} nodeTypes={nodeTypes} height={height} layoutKey={`${modules.length}`} minZoom={0.25} maxZoom={1.6} ariaLabel={t('bench.productStructure')} />;
}
