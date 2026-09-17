import { useEffect, useRef, type ReactNode } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useViewport, type Edge, type Node, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useT } from '@/lib/prefs';

/**
 * 工作台与模块图共用的流程图画布。
 *
 * 取舍：
 * - **缩放走按钮**（− / 百分比 / + / 适应画布），滚轮默认平移、按住 Ctrl/⌘ 才缩放——
 *   这两张图都嵌在会上下滚动的页面里，滚一下就把图缩成一粒米，是最常见的误操作。
 * - **节点不可拖**：位置由布局算出来，拖乱了没有保存的地方，也没有意义。
 * - **容器从不可见变可见时重新适应画布**：模块图常放在折叠区里，折叠时尺寸是 0，
 *   首次 fitView 算出来的视野是错的。
 */
const noop = () => undefined;

function ZoomBar() {
  const t = useT();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const btn = 'grid h-7 w-7 place-items-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return <div className="absolute bottom-3 right-3 z-10 flex items-center overflow-hidden rounded-md border border-border bg-card/95 shadow-sm backdrop-blur" role="toolbar" aria-label={t('flow.zoom')}>
    <button type="button" className={btn} onClick={() => void zoomOut()} aria-label={t('flow.zoomOut')} title={t('flow.zoomOut')}><Minus size={14} /></button>
    <button type="button" className="h-7 min-w-[3.25rem] border-x border-border px-1 font-mono text-[0.6875rem] tabular-nums text-muted-foreground hover:bg-muted" onClick={() => void fitView({ padding: 0.18 })} title={t('flow.fit')}>{Math.round(zoom * 100)}%</button>
    <button type="button" className={btn} onClick={() => void zoomIn()} aria-label={t('flow.zoomIn')} title={t('flow.zoomIn')}><Plus size={14} /></button>
    <button type="button" className={`${btn} border-l border-border`} onClick={() => void fitView({ padding: 0.18 })} aria-label={t('flow.fit')} title={t('flow.fit')}><Maximize2 size={13} /></button>
  </div>;
}

function Refit({ wrapper, layoutKey }: { wrapper: React.RefObject<HTMLDivElement>; layoutKey: string }) {
  /**
   * `fitView` 的引用会随视野变化而变。副作用若依赖它，每点一次 +/− 就会被重新「适应画布」拉回去——
   * 2026-09-17 实测按钮点了没反应就是这个。用 ref 拿最新的函数，副作用只跟「测完尺寸 / 布局变了 / 从隐藏变可见」走。
   */
  const { fitView } = useReactFlow();
  const fit = useRef(fitView);
  fit.current = fitView;
  const refit = () => requestAnimationFrame(() => void fit.current({ padding: 0.18 }));
  // 节点尺寸测出来之前 fitView 算的是零尺寸，视野是错的：等测完再适应一次。
  // 每个布局只在第一次测完时适应一次：节点数据一变（比如选中了一个模块）会重新测量，
  // 若每次都适应，人刚放大的视野就被拉回去。
  const measured = useNodesInitialized();
  const fittedFor = useRef<string | null>(null);
  useEffect(() => { if (measured && fittedFor.current !== layoutKey) { fittedFor.current = layoutKey; refit(); } }, [measured, layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const seen = useRef(false);
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const visible = (entry?.contentRect.width ?? 0) > 0 && (entry?.contentRect.height ?? 0) > 0;
      if (visible && !seen.current) { seen.current = true; refit(); }
      if (!visible) seen.current = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [wrapper]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * 内容没变就沿用上一份数组。
 *
 * 页面每几秒轮询一次运行列表，调用方每次都会重建节点对象（数据里还带着新建的回调）。
 * @xyflow 见到新对象就重新测量，测完之前节点是 `visibility: hidden`——2026-09-17 实测
 * 在这个窗口里点击会落到背景层上，节点点不到。按内容（去掉函数）算签名，签名不变就不换。
 * 回调函数不进签名：它们只读稳定的东西（导航、或本身已在数据里的状态）。
 */
function useStable<T>(value: T[]): T[] {
  const sig = JSON.stringify(value, (_k, v) => (typeof v === 'function' ? undefined : v));
  const ref = useRef<{ sig: string; value: T[] }>({ sig, value });
  if (ref.current.sig !== sig) ref.current = { sig, value };
  return ref.current.value;
}

export function FlowCanvas({ nodes: rawNodes, edges: rawEdges, nodeTypes, height, layoutKey, minZoom = 0.3, maxZoom = 1.6, ariaLabel, children }: {
  nodes: Node[]; edges: Edge[]; nodeTypes: NodeTypes; height: number | string; layoutKey: string;
  minZoom?: number; maxZoom?: number; ariaLabel: string; children?: ReactNode;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const nodes = useStable(rawNodes);
  const edges = useStable(rawEdges);
  return <div ref={wrapper} className="tp-flow relative w-full overflow-hidden rounded-lg border border-border bg-background" style={{ height }} aria-label={ariaLabel}>
    <ReactFlowProvider>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
        /* 不可选、不可拖、又没有点击回调的节点，@xyflow 会给它 pointer-events: none——
           节点里的按钮就全点不到了。给一个空回调把事件留给节点自己的按钮。 */
        onNodeClick={noop}
        panOnScroll zoomOnScroll={false} zoomActivationKeyCode={['Meta', 'Control']} zoomOnDoubleClick={false}
        minZoom={minZoom} maxZoom={maxZoom}
        proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(var(--border))" />
        <ZoomBar />
        <Refit wrapper={wrapper} layoutKey={layoutKey} />
        {children}
      </ReactFlow>
    </ReactFlowProvider>
  </div>;
}
