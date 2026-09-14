import { useEffect, useRef, useState, type FormEvent } from 'react';
import { API_BASE } from '@/lib/base';
import { useT } from '@/lib/prefs';
import { useStore } from '@/lib/store';
import { Button } from '@/components/ui';
import { workflowBase, workflowRequest, workflowRequestId } from '@/lib/workflowRuns';
const field='w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary';
export function NewRunForm({projectId,onCreated,onClose}:{projectId:string;onCreated:(id:string)=>void;onClose:()=>void}) {
  const t=useT(),project=useStore(s=>s.projects.find(p=>p.id===projectId));
  const [outputLanguage,setOutputLanguage]=useState('zh'),[maxScreens,setMaxScreens]=useState(8),[sourceKind,setSourceKind]=useState<'spec'|'explore'>('explore'),[sourceUrl,setSourceUrl]=useState(project?.targetUrl??''),[text,setText]=useState(''),[materials,setMaterials]=useState<{name:string;text:string}[]>([]),[knowledge,setKnowledge]=useState(''),[rulePack,setRulePack]=useState(''),[limit,setLimit]=useState(6),[busy,setBusy]=useState(false),[error,setError]=useState(''),
    /**
     * 探索要不要带钱包、要不要允许点会改状态的东西。
     *
     * 这两件事以前只有 API 开得了——于是「从界面上建一次运行」永远只能跑到未登录、
     * 只读的那一半产品（docs/v3/24 §13）。一个只有 curl 才打得开的开关，
     * 对着界面工作的人等于没有。
     */
    [exploreWallet,setExploreWallet]=useState(false),[exploreInteract,setExploreInteract]=useState(false),
    /**
     * 项目里已经存着的规则包版本。
     *
     * 以前这里只有一个「粘贴 JSON」的框——每跑一次贴一遍，同一个项目两次运行用着不同的包
     * 而没人看得出来。现在默认用项目当前那一版（留空即可，服务端会取），
     * 要用别的版本就在这里选，要临时试一份新的仍然可以贴。
     */
    [projectPacks,setProjectPacks]=useState<Array<{hash:string;packId:string;version:string}>>([]),[packHash,setPackHash]=useState(''),
    /**
     * 按模块拆成工作单元。
     *
     * 2026-09-12 实测（docs/v3/24 §12）：不拆的时候，整份故事由一次模型调用写完，
     * 可见输出卡在 ~7k token——**加提示词买到的是思考，不是覆盖**。同一个模型拆成
     * 六个单元之后，故事从 26 条涨到 44 条。而这个开关此前只有 API 打得开，
     * 界面上建的运行永远撞在那个天花板上。
     */
    [workUnits,setWorkUnits]=useState(true);
  const intent=useRef<{hash:string;key:string}>();
  useEffect(()=>{const c=new AbortController();
    void fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/rule-packs`,{signal:c.signal})
      .then(r=>r.json()).then((d:{packs?:Array<{hash:string;packId:string;version:string}>})=>setProjectPacks(d.packs??[])).catch(()=>{});
    return()=>c.abort();},[projectId]);
  // 规则包在前端只做 JSON 语法检查；引用、来源、P0 依据由服务端 validateRulePack 拒绝。
  const parsedPack=(()=>{if(!rulePack.trim())return undefined;try{return JSON.parse(rulePack) as unknown;}catch{return null;}})();
  const packError=parsedPack===null;
  async function start(e:FormEvent) {e.preventDefault();setBusy(true);setError('');const chosen=packHash?await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/rule-packs/${packHash}`).then(r=>r.json()).then((d:{pack?:unknown})=>d.pack):undefined;
    const payload={sourceKind,outputLanguage,maxScreens,sourceUrl:sourceKind==='explore'?sourceUrl:undefined,
      ...(sourceKind==='explore'?{exploreWallet,exploreActions:exploreInteract?'interact':'observe'}:{}),materials:[...materials,...(text.trim()?[{name:'requirements.md',text}]:[])],knowledge:knowledge.trim()?[{name:'domain-knowledge.md',text:knowledge,roles:['source','stories','cases','gate']}]:[],rulePacks:chosen?[chosen]:parsedPack?[parsedPack]:[],workUnits,limit};const hash=JSON.stringify(payload);if(intent.current?.hash!==hash)intent.current={hash,key:workflowRequestId()};try{const run=await workflowRequest<{wfRunId:string}>(workflowBase(projectId),{...payload,idempotencyKey:intent.current.key});onCreated(run.wfRunId);}catch(e){setError(e instanceof Error?e.message:'request_failed');}finally{setBusy(false);}}
  return <form onSubmit={e=>void start(e)} className="mx-auto w-full max-w-2xl space-y-5 p-6" aria-label={t('workflow.new')}><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{t('workflow.new')}</h2><Button onClick={onClose}>{t('bench.close')}</Button></div>
    <div className="grid grid-cols-3 gap-2">{(['spec','explore','code'] as const).map(k=><button key={k} type="button" disabled={k==='code'||busy} aria-pressed={sourceKind===k} className={`rounded-md border p-3 text-sm disabled:opacity-40 ${sourceKind===k?'border-primary bg-primary/10 text-primary':'border-border'}`} onClick={()=>k!=='code'&&setSourceKind(k)}>{t(`bench.source.${k}`)}</button>)}</div>
    {sourceKind==='explore'?<label className="block space-y-2 text-sm"><span>{t('bench.target')}</span><input type="url" required className={field} value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)} /></label>:<><label className="block space-y-2 text-sm"><span>{t('workflow.requirements')}</span><textarea rows={6} className={field} required={!materials.length} value={text} onChange={e=>setText(e.target.value)}/></label><label className="block space-y-2 text-sm"><span>{t('bench.upload')}</span><input type="file" multiple accept=".md,.txt" onChange={e=>{const files=[...e.target.files??[]];if(files.length>20){setError(t('bench.tooManyFiles'));return;}void Promise.all(files.map(async f=>{if(!/\.(md|txt)$/i.test(f.name))throw new Error(t('bench.textOnly'));if(f.size>2_000_000)throw new Error(t('bench.fileTooLarge'));return {name:f.name,text:await f.text()};})).then(setMaterials).catch(e=>setError(String(e.message)));}}/></label><ul className="text-xs text-muted-foreground">{materials.map((f,i)=><li key={i}>{f.name} · {f.text.length} chars</li>)}</ul></>}
    <label className="block space-y-2 text-sm"><span>{t('bench.knowledge')}</span><textarea className={field} rows={3} value={knowledge} onChange={e=>setKnowledge(e.target.value)} placeholder={t('bench.knowledgeHint')}/></label>
    {sourceKind==='explore'&&projectPacks.length>0&&<label className="block space-y-2 text-sm"><span>{t('bench.rulePackVersion')}</span>
      <select className={field} value={packHash} onChange={e=>setPackHash(e.target.value)}>
        <option value="">{t('bench.rulePackLatest')}</option>
        {projectPacks.map(p=><option key={p.hash} value={p.hash}>{p.packId} · v{p.version} · {p.hash.slice(0,8)}</option>)}
      </select><span className="block text-xs text-muted-foreground">{t('bench.rulePackVersionHint')}</span></label>}
    {sourceKind==='explore'&&<label className="block space-y-2 text-sm"><span>{t('bench.rulePack')}</span><textarea className={field} rows={3} value={rulePack} onChange={e=>setRulePack(e.target.value)} placeholder={t('bench.rulePackHint')} aria-invalid={packError}/><input type="file" accept=".json" onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>2_000_000){setError(t('bench.fileTooLarge'));return;}void f.text().then(setRulePack).catch(err=>setError(String(err.message)));}}/>{packError&&<span className="text-xs text-bad">{t('bench.rulePackInvalid')}</span>}</label>}
    <div className="flex flex-wrap gap-4"><label className="flex items-center gap-3 text-sm">{t('bench.outputLanguage')}<select className={field} value={outputLanguage} onChange={e=>setOutputLanguage(e.target.value)}><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option></select></label>{sourceKind==='explore'&&<label className="flex items-center gap-3 text-sm">{t('bench.maxScreens')}<input className={`${field} max-w-24`} type="number" min={1} max={50} value={maxScreens} onChange={e=>setMaxScreens(Number(e.target.value))}/></label>}</div>
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={workUnits} onChange={e=>setWorkUnits(e.target.checked)}/>
      <span><span className="font-medium">{t('bench.workUnits')}</span><span className="mt-1 block text-xs text-muted-foreground">{t('bench.workUnitsHint')}</span></span></label>
    {sourceKind==='explore'&&<fieldset className="space-y-3 rounded-md border border-border p-4 text-sm">
      <legend className="px-1 text-xs text-muted-foreground">{t('bench.exploreDepth')}</legend>
      <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={exploreWallet} onChange={e=>setExploreWallet(e.target.checked)}/>
        <span><span className="font-medium">{t('bench.exploreWallet')}</span><span className="mt-1 block text-xs text-muted-foreground">{t('bench.exploreWalletHint')}</span></span></label>
      <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={exploreInteract} onChange={e=>setExploreInteract(e.target.checked)}/>
        <span><span className="font-medium">{t('bench.exploreInteract')}</span><span className="mt-1 block text-xs text-muted-foreground">{t('bench.exploreInteractHint')}</span></span></label>
      {exploreInteract&&<p className="text-xs text-warn">{t('bench.exploreInteractWarn')}</p>}
    </fieldset>}
    <label className="flex items-center gap-3 text-sm">{t('workflow.limit')}<input className={`${field} max-w-24`} type="number" min={1} max={50} value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label>
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}<div className="flex justify-end"><Button type="submit" variant="primary" disabled={busy||packError}>{t(busy?'workflow.starting':'workflow.start')}</Button></div>
  </form>;
}
