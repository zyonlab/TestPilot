import { artifactLabel } from './artifactLabel';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Drawer } from '@/components/overlay';
import { useT } from '@/lib/prefs';
import type { Revision } from '@/lib/workflowRuns';
import { RevisionViewer } from './RevisionViewer';
/** Open documents above the node drawer so its context and scroll position survive. */
export function NodeArtifacts({projectId,revisions,all,descriptions}:{projectId:string;revisions:Revision[];all:Revision[];descriptions?:Record<string,string>}) {
  const t=useT(),[selected,setSelected]=useState<Revision|null>(null);
  const label=(r:Revision)=>artifactLabel(r.name,t);
  return <>
    <div className="space-y-2">{revisions.map(r=><button key={r.id} type="button" aria-haspopup="dialog" className="flex w-full items-center justify-between gap-3 rounded border border-border bg-card p-3 text-left text-sm text-primary hover:bg-muted" onClick={()=>setSelected(r)}>
      <span className="break-words">{label(r)} · v{r.revision}{descriptions?.[r.id]&&<small className="mt-1 block text-xs text-muted-foreground">{descriptions[r.id]}</small>}</span><ChevronRight size={16} className="shrink-0"/>
    </button>)}</div>
    <Drawer open={!!selected} onClose={()=>setSelected(null)} layer={1} resizeKey="bench-node-document" defaultWidth={960} fullscreen title={selected?`${label(selected)} · v${selected.revision}`:''}>
      {selected&&<div className="p-5"><RevisionViewer hideTitle key={selected.id} projectId={projectId} revision={selected} all={all} onSelect={setSelected}/></div>}
    </Drawer>
  </>;
}
