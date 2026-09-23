import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useState } from 'react';
import { useT } from '@/lib/prefs';
import { FlowCanvas } from './FlowCanvas';
type State = {id:string;route:string;title?:string;controls?:string[]};
type Effect = {controlsAdded?:string[];controlsRemoved?:string[];stateChanged?:string[];textAdded?:string[];textRemoved?:string[]};
type Transition = {from:string;to?:string;action:{kind:string;target:string};ok:boolean;walked?:boolean;note?:string;effect?:Effect};
export type ExplorationGraphData = {entry?:string;states:State[];transitions:Transition[]};
type StateData = {id:string;label:string;route:string;action:string;summary:string;selected:boolean;onSelect:(id:string)=>void};
function StateNode({data}:NodeProps<Node<StateData>>) {
  return <div className={`rounded border bg-card p-3 text-xs ${data.selected?'border-primary':'border-border'}`} style={{width:245}}><Handle type="target" position={Position.Top}/><button className="nodrag w-full text-left" onClick={()=>data.onSelect(data.id)}><strong>{data.label} · {data.action}</strong><span className="mt-1 block break-all font-mono text-muted-foreground">{data.route}</span><span className="mt-2 block leading-relaxed">{data.summary}</span></button><Handle type="source" position={Position.Bottom}/></div>;
}
const nodeTypes={state:StateNode};
const cleanText=(items:string[]=[])=>([...new Set(items)]).filter(s=>!/^=====.*=====$/.test(s.trim()));
export function ExplorationGraph({graph}:{graph:ExplorationGraphData}) {
  const t=useT(),[selected,setSelected]=useState(graph.entry??graph.states[0]?.id??''),[transitionIndex,setTransitionIndex]=useState<number|null>(null);
  const {states,transitions}=graph;
  const label=(id?:string)=>{const index=states.findIndex(s=>s.id===id);return index<0?'—':`S${index+1}`;};
  const firstArrival=(id:string)=>transitions.findIndex(e=>e.to===id&&e.from!==id&&e.walked!==false&&e.ok);
  const summary=(e?:Transition)=>{
    if(!e)return t('exploration.noDiff');
    if(e.walked===false)return t('exploration.unwalked');
    const fx=e.effect;
    const parts=[fx?.controlsAdded?.length?`${t('exploration.added')} ${fx.controlsAdded.length}`:'',fx?.controlsRemoved?.length?`${t('exploration.removed')} ${fx.controlsRemoved.length}`:'',fx?.stateChanged?.length?`${t('exploration.changed')} ${fx.stateChanged.length}`:'',cleanText(fx?.textAdded).length?`${t('exploration.textAdded')} ${cleanText(fx?.textAdded).length}`:''].filter(Boolean);
    return parts.join(' · ')||t('exploration.noDiff');
  };
  const chooseState=(id:string)=>{setSelected(id);const index=firstArrival(id);setTransitionIndex(index<0?null:index);};
  const chooseTransition=(i:number)=>{setTransitionIndex(i);setSelected(transitions[i]?.to??transitions[i]?.from??'');};
  const nodes=states.map((s,i)=>{const arrival=transitions[firstArrival(s.id)];return {id:s.id,type:'state',position:{x:(i%3)*300,y:Math.floor(i/3)*190},data:{id:s.id,label:label(s.id),route:s.route,action:arrival?.action.target??(s.id===graph.entry?t('exploration.entry'):t('exploration.observed')),summary:summary(arrival),selected:s.id===selected,onSelect:chooseState}};});
  const edges=transitions.map((e,i)=>({e,i})).filter(({e})=>e.to&&states.some(s=>s.id===e.to)).map(({e,i})=>({id:`transition-${i}`,source:e.from,target:e.to!,label:`${i+1}. ${e.action.target}`,type:'default',style:{stroke:i===transitionIndex?'hsl(var(--primary))':e.ok?'hsl(var(--muted-foreground))':'hsl(var(--bad))',strokeWidth:i===transitionIndex?3:1,strokeDasharray:e.walked===false?'5 4':undefined}}));
  const state=states.find(s=>s.id===selected),transition=transitionIndex===null?undefined:transitions[transitionIndex];
  const related=transitions.map((e,i)=>({e,i})).filter(({e})=>e.to===selected||e.from===selected);
  const groups:[string,string[]][]=transition?[[t('exploration.added'),transition.effect?.controlsAdded??[]],[t('exploration.removed'),transition.effect?.controlsRemoved??[]],[t('exploration.changed'),transition.effect?.stateChanged??[]],[t('exploration.textAdded'),cleanText(transition.effect?.textAdded)],[t('exploration.textRemoved'),cleanText(transition.effect?.textRemoved)]]:[];
  return <section className="space-y-3"><h3 className="font-medium">{t('exploration.graph')} · {states.length}</h3>
    <p className="text-xs text-muted-foreground">{t('exploration.graphHelp')}</p>
    <FlowCanvas nodes={nodes} edges={edges} nodeTypes={nodeTypes} height={460} layoutKey={states.map(s=>s.id).join('|')} ariaLabel={t('exploration.graph')} onEdgeClick={id=>chooseTransition(Number(id.replace('transition-','')))}/>
    {state&&<section className="space-y-3 rounded border border-border p-4 text-sm" aria-label={t('exploration.diff')}>
      <h4 className="font-semibold">{label(state.id)} · {state.route}</h4>
      <label className="block">{t('exploration.transitions')}<select className="mt-1 block w-full rounded border border-border bg-background p-2 text-xs" value={transitionIndex??''} onChange={e=>e.target.value!==''&&chooseTransition(Number(e.target.value))}><option value="" disabled>{t('exploration.pickTransition')}</option>{related.map(({e,i})=><option key={i} value={i}>{i+1}. {label(e.from)} → {label(e.to)} · {e.action.target}{e.walked===false?` · ${t('exploration.unwalked')}`:''}</option>)}</select></label>
      {transition&&<><p className="font-medium">{label(transition.from)} → {label(transition.to)} · {transition.action.kind}: {transition.action.target}</p><p className="text-xs text-muted-foreground">{summary(transition)}</p>
        {transition.from===transition.to&&<p className="text-xs text-muted-foreground">{t('exploration.sameState')}</p>}
        {!transition.ok&&<p className="text-bad">{transition.note??t('exploration.failed')}</p>}
        {groups.filter(([,items])=>items.length).map(([title,items])=><div key={title}><h5 className="font-medium">{title} · {items.length}</h5><ul className="mt-1 max-h-48 list-disc space-y-1 overflow-auto pl-5 text-xs">{items.map((item,i)=><li key={i} className="whitespace-pre-wrap break-words">{item}</li>)}</ul></div>)}
      </>}
      <details className="text-xs"><summary className="cursor-pointer">{t('exploration.snapshot')}</summary><p className="mt-2 break-all">ID: {state.id}</p><ul>{state.controls?.map((c,i)=><li key={i}>{c}</li>)}</ul></details>
    </section>}
    <details><summary className="cursor-pointer text-sm">{t('exploration.transitions')} · {transitions.length}</summary><ul className="mt-2 space-y-2 text-xs">{transitions.map((e,i)=><li key={i}><button className="w-full rounded border border-border p-2 text-left hover:border-primary" onClick={()=>chooseTransition(i)}>{i+1}. {label(e.from)} → {label(e.to)} · {e.action.target}<span className="mt-1 block text-muted-foreground">{summary(e)}</span></button></li>)}</ul></details>
  </section>;
}
