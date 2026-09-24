import {useEffect,useState} from 'react';
import {workflowRequest,type Revision} from '@/lib/workflowRuns';
import {useT} from '@/lib/prefs';
import {Button} from '@/components/ui';
import {DocumentFields} from './ArtifactDocument';
type Version={id:string;assetKey:string;sourceRun:string;sourceRevision:string;baseVersion:string|null;status:string;staleDependencies:string[];dependencies:string[]};
type Library={heads:Record<string,string>;versions:Version[];snapshots:Array<{id:string;label:string;digest:string;createdAt:string}>};
export function ProjectAssetLibrary({projectId,source}:{projectId:string;source?:Revision}){
 const t=useT(),base=`projects/${encodeURIComponent(projectId)}/assets`;
 const [data,setData]=useState<Library>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[assetKey,setAssetKey]=useState(''),[reason,setReason]=useState(''),[dependencies,setDependencies]=useState<string[]>([]),[selected,setSelected]=useState(''),[comparison,setComparison]=useState<{current:unknown;previous:unknown}>(),[label,setLabel]=useState('');
 const refresh=()=>workflowRequest<Library>(base).then(setData);
 useEffect(()=>{let live=true;workflowRequest<Library>(base).then(x=>{if(live)setData(x);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[base]);
 useEffect(()=>{setAssetKey(source?.name??'');setDependencies([]);},[source?.id]);
 async function act(path:string,body:unknown){setBusy(true);setError('');try{await workflowRequest(base+path,body);await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
 useEffect(()=>{let live=true;setComparison(undefined);setReason('');if(!selected)return;
  const load=async()=>{const current=await workflowRequest<{version:Version;content:unknown}>(base+'/versions/'+selected);const prior=data?.heads[current.version.assetKey];const previous=prior===selected?current:prior?await workflowRequest<{content:unknown}>(base+'/versions/'+prior):undefined;if(live)setComparison({current:current.content,previous:previous?.content});};
  void load().catch(e=>{if(live)setError(String(e));});return()=>{live=false;};
 },[base,selected,data?.heads]);
 const version=data?.versions.find(v=>v.id===selected);
 return <section className="mb-6 space-y-3 rounded border border-border p-4"><h2 className="font-semibold">{t('assets.title')}</h2><p className="text-sm text-muted-foreground">{t('assets.hint')}</p>
 {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
 {source&&(['material','stories','cases','modules'].includes(source.kind)||['product/model-candidate','validated/modules'].includes(source.name))&&<div className="space-y-2 rounded bg-muted p-3"><p className="text-sm">{t('assets.source')}: {source.name} · v{source.revision}</p><input aria-label={t('assets.key')} placeholder={t('assets.key')} value={assetKey} onChange={e=>setAssetKey(e.target.value)} className="w-full rounded border border-border bg-card p-2 text-sm"/>
 <fieldset><legend className="text-sm">{t('assets.dependencies')}</legend>{Object.entries(data?.heads??{}).filter(([k])=>k!==assetKey).map(([k,id])=><label key={id} className="mr-3 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={dependencies.includes(id)} onChange={e=>setDependencies(e.target.checked?[...dependencies,id]:dependencies.filter(x=>x!==id))}/>{k}</label>)}</fieldset>
 <Button disabled={busy||!assetKey.trim()} onClick={()=>void act('/candidates',{assetKey:assetKey.trim(),sourceRevision:source.id,baseVersion:data?.heads[assetKey.trim()]??null,dependencies})}>{t('assets.import')}</Button></div>}
 <div className="flex flex-wrap gap-2"><select aria-label={t('assets.version')} value={selected} onChange={e=>setSelected(e.target.value)} className="max-w-full rounded border border-border bg-card p-2 text-sm"><option value="">{t('assets.pick')}</option>{data?.versions.map(v=><option key={v.id} value={v.id}>{v.assetKey} · {t(`assets.${v.status}`)} · {v.id.slice(-8)}</option>)}</select></div>
 {version&&<div className="space-y-3"><p className="break-all text-xs text-muted-foreground">{t('assets.source')}: {version.sourceRun} / {version.sourceRevision}</p>{version.staleDependencies.length>0&&<p className="text-sm text-warn">{t('assets.stale')}: {version.staleDependencies.length}</p>}
 {comparison&&<div className="grid gap-3 lg:grid-cols-2"><div className="min-w-0 rounded border border-border p-3"><h3 className="text-sm font-medium">{t('assets.acceptedContent')}</h3><DocumentFields data={comparison.previous??null}/></div><div className="min-w-0 rounded border border-border p-3"><h3 className="text-sm font-medium">{t('assets.candidateContent')}</h3><DocumentFields data={comparison.current}/></div></div>}
 {version.status==='candidate'&&<div className="flex flex-wrap gap-2"><input aria-label={t('assets.reason')} placeholder={t('assets.reason')} value={reason} onChange={e=>setReason(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-card p-2 text-sm"/><Button disabled={busy||!reason.trim()||!comparison} onClick={()=>void act('/versions/'+version.id+'/decision',{action:'adopt',expectedHead:data?.heads[version.assetKey]??null,reason})}>{t('assets.adopt')}</Button><Button disabled={busy||!reason.trim()} onClick={()=>void act('/versions/'+version.id+'/decision',{action:'reject',expectedHead:data?.heads[version.assetKey]??null,reason})}>{t('assets.reject')}</Button></div>}
 </div>}
 {data&&!data.versions.length&&<p className="text-sm">{t('assets.empty')}</p>}
 <div className="flex flex-wrap gap-2"><input aria-label={t('assets.snapshotName')} placeholder={t('assets.snapshotName')} value={label} onChange={e=>setLabel(e.target.value)} className="rounded border border-border bg-card p-2 text-sm"/><Button disabled={busy||!label.trim()||!Object.keys(data?.heads??{}).length} onClick={()=>void act('/snapshots',{label})}>{t('assets.snapshot')}</Button></div><p className="text-xs text-muted-foreground">{t('assets.snapshotHint')}</p>
 {data?.snapshots.map(s=><details key={s.id} className="text-sm"><summary>{s.label} · {s.createdAt}</summary><p className="break-all text-xs">{s.id} · {s.digest}</p></details>)}
 </section>;
}
