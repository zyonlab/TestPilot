import {useEffect,useState} from 'react';
import {API_BASE} from '@/lib/base';
import {useT} from '@/lib/prefs';
import {Button} from '@/components/ui';
import {FieldChatDrawer} from '@/components/FieldChatDrawer';
type Entry={id:string;title:string;builtin:boolean;valid?:boolean};
export function KnowledgeSelect({projectId,kind,value,onChange,exampleDefault,onReady}:{projectId:string;kind:'domainKnowledge'|'rulePack';value:string|null;onChange:(value:string|null)=>void;exampleDefault:boolean;onReady:(ready:boolean)=>void}){
 const t=useT(),[entries,setEntries]=useState<Entry[]>([]),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[drafting,setDrafting]=useState(false),[content,setContent]=useState<unknown>(),[refresh,setRefresh]=useState(0);
 const base=`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/knowledge-library/${kind}`;
 useEffect(()=>{const c=new AbortController();setLoaded(false);void fetch(base,{signal:c.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);return d.entries as Entry[];}).then(rows=>{if(c.signal.aborted)return;setEntries(rows);setError('');setLoaded(true);if(refresh===0&&exampleDefault&&!value)onChange(rows.find(r=>r.builtin)?.id??null);}).catch(e=>{if(!c.signal.aborted){setError(String(e.message));setLoaded(true);}});return()=>c.abort();},[base,refresh]);
 useEffect(()=>{setContent(undefined);if(!value)return;const c=new AbortController();void fetch(`${base}/${encodeURIComponent(value)}`,{signal:c.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);return d.value;}).then(v=>{if(!c.signal.aborted)setContent(v);}).catch(e=>{if(!c.signal.aborted)setError(String(e.message));});return()=>c.abort();},[base,value]);
 useEffect(()=>onReady(loaded&&!error&&(!value||content!==undefined)),[loaded,error,value,content,onReady]);
 const title=t(kind==='rulePack'?'bench.rulePack':'bench.knowledge');
 return <section className="space-y-2 rounded-lg border border-border p-3">
  <label className="block space-y-2 text-sm"><span className="font-medium">{title}</span><select className="w-full rounded-md border border-border bg-background px-3 py-2" value={value??''} disabled={!loaded} onChange={e=>onChange(e.target.value||null)}><option value="">{t('library.none')}</option>{entries.map(e=><option key={e.id} value={e.id} disabled={e.valid===false}>{e.builtin?t('library.builtin'):`${e.title} · ${e.id.slice(0,8)}`}</option>)}</select></label>
  <p className="text-xs text-muted-foreground">{t('library.hint')}</p>
  <div className="flex gap-2"><Button type="button" size="sm" disabled={!!value&&content===undefined} onClick={()=>setDrafting(true)}>{t('field.chat')}</Button><Button type="button" size="sm" onClick={()=>setRefresh(n=>n+1)}>{t('workflow.refresh')}</Button></div>
  {error&&<p role="alert" className="text-xs text-bad">{error}</p>}
  {content!==undefined&&<details><summary className="cursor-pointer text-xs">{t('library.preview')}</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">{typeof content==='string'?content:JSON.stringify(content,null,2)}</pre></details>}
  {drafting&&<FieldChatDrawer field={kind} projectId={projectId} title={title} initialValue={content} applyLabel={t('library.save')} onClose={()=>setDrafting(false)} onApply={async value=>{const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value})});const d=await r.json();if(!r.ok)return d.error??'save_failed';onChange(d.id);setRefresh(n=>n+1);}}/>}
 </section>;
}
