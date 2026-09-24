import {PlannerHost} from "@/components/PlannerHost";
import { ExplorationSettings } from '@/components/ExplorationSettings';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/lib/prefs';
import { useStore } from '@/lib/store';
import { Button } from '@/components/ui';
import { KnowledgeSelect } from './KnowledgeSelect';
import { workflowRequest } from '@/lib/workflowRuns';
import { exampleForUrl, useExamples } from '@/lib/examples';
const field='w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary';
export function NewRunForm({projectId,onCreated,onClose}:{projectId:string;onCreated:(id:string)=>void;onClose:()=>void}) {
  const t=useT(),project=useStore(s=>s.projects.find(p=>p.id===projectId));
  const [outputLanguage,setOutputLanguage]=useState('zh'),[maxScreens,setMaxScreens]=useState(project?.explorationMaxScreens??8),[explorationScope,setExplorationScope]=useState<"current-url"|"rules">(project?.explorationScope??"rules"),[sourceKind,setSourceKind]=useState<'spec'|'explore'>('explore'),[sourceUrl,setSourceUrl]=useState(project?.targetUrl??''),[pageVersion,setPageVersion]=useState(''),[text,setText]=useState(''),[materials,setMaterials]=useState<{name:string;text:string}[]>([]),[knowledgeSelection,setKnowledgeSelection]=useState<string|null>(null),[rulePackSelection,setRulePackSelection]=useState<string|null>(null),[limit,setLimit]=useState(6),[busy,setBusy]=useState(false),[error,setError]=useState(''),
    /**
     * 探索要不要带钱包、要不要允许点会改状态的东西。
     *
     * 这两件事以前只有 API 开得了——于是「从界面上建一次运行」永远只能跑到未登录、
     * 只读的那一半产品（docs/v3/history/24 §13）。一个只有 curl 才打得开的开关，
     * 对着界面工作的人等于没有。
     */
    [exploreWallet,setExploreWallet]=useState(false),[exploreInteract,setExploreInteract]=useState(false),
    /**
     * 按模块拆成工作单元。
     *
     * 2026-09-12 实测（docs/v3/history/24 §12）：不拆的时候，整份故事由一次模型调用写完，
     * 可见输出卡在 ~7k token——**加提示词买到的是思考，不是覆盖**。同一个模型拆成
     * 六个单元之后，故事从 26 条涨到 44 条。而这个开关此前只有 API 打得开，
     * 界面上建的运行永远撞在那个天花板上。
     */
    [workUnits,setWorkUnits]=useState(true),
    /** 规划由谁跑：留空用服务端默认（`TP_AGENT_RUNTIME`，不设时是 Claude Code）。 */
    [hostReady,setHostReady]=useState(false);
  const [knowledgeReady,setKnowledgeReady]=useState(false),[rulesReady,setRulesReady]=useState(false);
  const [runMode,setRunMode]=useState('clean'),[snapshotId,setSnapshotId]=useState(''),[snapshots,setSnapshots]=useState<Array<{id:string;label:string}>>([]),[preview,setPreview]=useState<{id:string;hash:string;mode:string;inputDigest:string}>();
  useEffect(()=>{let live=true;workflowRequest<{snapshots:Array<{id:string;label:string}>}>(`projects/${projectId}/assets`).then(x=>{if(live)setSnapshots(x.snapshots);}).catch(e=>setError(String(e)));return()=>{live=false;};},[projectId]);
  const examples=useExamples(),exampleId=exampleForUrl(examples,project?.targetUrl)?.id;
  async function start(e:FormEvent) {e.preventDefault();if(!hostReady||!knowledgeReady||!rulesReady||busy)return;setBusy(true);setError('');
    const payload={pageVersion:pageVersion.trim()||undefined,sourceKind,outputLanguage,maxScreens,explorationScope,planner:'connected',sourceUrl:sourceKind==='explore'?sourceUrl:undefined,
      ...(sourceKind==='explore'?{exploreWallet,exploreActions:exploreInteract?'interact':'observe'}:{}),materials:[...materials,...(text.trim()?[{name:'requirements.md',text}]:[])],knowledgeSelection,rulePackSelection,workUnits,limit};const hash=JSON.stringify({payload,runMode,snapshotId});try{if(!preview||preview.hash!==hash){const plan=await workflowRequest<{id:string;mode:string;inputDigest:string}>(`projects/${projectId}/assets/plans`,{mode:runMode,label:new Date().toISOString(),...(runMode==='incremental'?{snapshotId}:{}),configuration:payload});setPreview({...plan,hash});return;}const run=await workflowRequest<{wfRunId:string}>(`projects/${projectId}/assets/plans/${preview.id}/start`,{});onCreated(run.wfRunId);}catch(e){setError(e instanceof Error?e.message:'request_failed');}finally{setBusy(false);}}
  return <form onSubmit={e=>void start(e)} className="mx-auto w-full max-w-2xl space-y-5 p-6" aria-label={t('workflow.new')}><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{t('workflow.new')}</h2><Button type="button" onClick={onClose}>{t('bench.close')}</Button></div>
    <p className="text-sm leading-relaxed text-muted-foreground">{t("bench.newHint")}</p>
    <PlannerHost projectId={projectId} onReady={setHostReady}/>
    <div className="grid grid-cols-3 gap-2">{(['spec','explore','code'] as const).map(k=><button key={k} type="button" disabled={k==='code'||busy} aria-pressed={sourceKind===k} className={`rounded-md border p-3 text-sm disabled:opacity-40 ${sourceKind===k?'border-primary bg-primary/10 text-primary':'border-border'}`} onClick={()=>k!=='code'&&setSourceKind(k)}>{t(`bench.source.${k}`)}</button>)}</div>
    {sourceKind==='explore'?<><label key="source-url" className="block space-y-2 text-sm"><span>{t('bench.target')}</span><input type="url" required className={field} value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)} /></label><label key="page-version" className="block space-y-2 text-sm"><span>{t('reuse.pageVersion')}</span><input className={field} maxLength={160} value={pageVersion} onChange={e=>setPageVersion(e.target.value)}/><p className="text-xs text-muted-foreground">{t('reuse.versionHelp')}</p></label></>:<><label key="requirements" className="block space-y-2 text-sm"><span>{t('workflow.requirements')}</span><textarea rows={6} className={field} required={!materials.length} value={text} onChange={e=>setText(e.target.value)}/></label><label key="material-upload" className="block space-y-2 text-sm"><span>{t('bench.upload')}</span><input type="file" multiple accept=".md,.txt" onChange={e=>{const files=[...e.target.files??[]];if(files.length>20){setError(t('bench.tooManyFiles'));return;}void Promise.all(files.map(async f=>{if(!/\.(md|txt)$/i.test(f.name))throw new Error(t('bench.textOnly'));if(f.size>2_000_000)throw new Error(t('bench.fileTooLarge'));return {name:f.name,text:await f.text()};})).then(setMaterials).catch(e=>setError(String(e.message)));}}/></label><ul className="text-xs text-muted-foreground">{materials.map((f,i)=><li key={i}>{f.name} · {f.text.length} chars</li>)}</ul></>}
    <label className="block text-sm">{t('plans.mode')}<select className={field} value={runMode} onChange={e=>{setRunMode(e.target.value);setPreview(undefined);}}>{['clean','incremental','rebuild'].map(m=><option key={m} value={m}>{t(`plans.${m}`)}</option>)}</select></label>
    {runMode==='incremental'&&<select aria-label={t('plans.snapshot')} className={field} value={snapshotId} onChange={e=>{setSnapshotId(e.target.value);setPreview(undefined);}} required><option value="">{t('plans.snapshot')}</option>{snapshots.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select>}
    {preview&&<div className="rounded border border-border p-3 text-sm"><p>{t('plans.preview')} · {t(`plans.${preview.mode}`)}</p><p>{t(preview.mode==='incremental'?'plans.inherit':'plans.isolated')}</p><p className="break-all text-xs">{preview.inputDigest}</p><p>{t('plans.noReset')}</p></div>}
    <KnowledgeSelect key={`${projectId}:knowledge`} projectId={projectId} kind="domainKnowledge" value={knowledgeSelection} onChange={setKnowledgeSelection} onReady={setKnowledgeReady} exampleId={exampleId}/>
    <KnowledgeSelect key={`${projectId}:rules`} projectId={projectId} kind="rulePack" value={rulePackSelection} onChange={setRulePackSelection} onReady={setRulesReady} exampleId={exampleId}/>
    <div className="flex flex-wrap gap-4"><label className="flex items-center gap-3 text-sm">{t('bench.outputLanguage')}<select className={field} value={outputLanguage} onChange={e=>setOutputLanguage(e.target.value)}><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option></select></label>{sourceKind==='explore'&&<ExplorationSettings maxScreens={maxScreens} scope={explorationScope} onChange={(n,s)=>{setMaxScreens(n);setExplorationScope(s);}}/>}</div>
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
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}<div className="flex justify-end"><Button type="submit" variant="primary" disabled={busy||!hostReady||!knowledgeReady||!rulesReady}>{t(busy?'workflow.starting':preview?'workflow.start':'plans.preview')}</Button></div>
  </form>;
}
