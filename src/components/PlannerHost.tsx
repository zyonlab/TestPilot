import {useEffect,useState} from 'react';
import {API_BASE} from '@/lib/base';
import {useT} from '@/lib/prefs';
import {Button} from '@/components/ui';
type Status={selected:string|null;hosts:{runtime:string;state:string;model:null}[];checkedAt:string};
export function PlannerHost({projectId,onReady}:{projectId:string;onReady?:(ready:boolean)=>void}){
 const t=useT(),[status,setStatus]=useState<Status>(),[error,setError]=useState(''),[version,setVersion]=useState(0),[saving,setSaving]=useState(false);
 const url=`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/planner-host`;
 useEffect(()=>{const c=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const r=await fetch(url,{signal:c.signal});const data=await r.json();if(!r.ok)throw new Error(data.error);if(!c.signal.aborted){setStatus(data);setError('');}}catch(e){if(!c.signal.aborted)setError(String((e as Error).message));}if(!c.signal.aborted)timer=setTimeout(()=>void poll(),30000);};void poll();return()=>{c.abort();clearTimeout(timer);};},[url,version]);
 const ready=!saving&&!error&&!!status?.selected&&status.hosts.some(h=>h.runtime===status.selected&&h.state==='ready');
 useEffect(()=>{onReady?.(ready);},[ready,onReady]);
 async function choose(runtime:string){if(!runtime)return;setSaving(true);try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runtime})});const data=await r.json();if(!r.ok)throw new Error(data.error);setStatus(data);setError('');}catch(e){setError(String((e as Error).message));}finally{setSaving(false);}}
 return <section className="space-y-2 rounded-md border border-border p-3 text-sm"><label className="block space-y-1"><span className="font-medium">{t('host.title')}</span><select className="w-full rounded-md border border-border bg-background px-2 py-1.5" value={status?.selected??''} disabled={saving||!status} onChange={e=>void choose(e.target.value)}><option value="">{t('host.choose')}</option>{status?.hosts.map(h=><option key={h.runtime} value={h.runtime} disabled={h.state!=='ready'}>{h.runtime==='codex'?'Codex':'Claude Code'} · {t(`host.state.${h.state}`)}</option>)}</select></label><p className="text-xs text-muted-foreground">{t('host.model')}</p><p className="text-xs text-muted-foreground">{t('host.independent')}</p>{error&&<p role="alert" className="text-xs text-bad">{error}</p>}<Button type="button" size="sm" disabled={saving} onClick={()=>setVersion(v=>v+1)}>{t('workflow.refresh')}</Button></section>;
}
