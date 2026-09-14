import {navigateProject} from '@/lib/projectContext';
import {useT} from '@/lib/prefs';
import {API_BASE} from '@/lib/base';
type Result=Record<string,unknown>;
function imageUrl(value:unknown){if(typeof value!=='string')return null;const path=value.split('/artifacts/')[1];return path&&/^exec\/[\w.-]+\.png$/.test(path)?`${API_BASE}/api/artifacts/${path}`:null;}
/**
 * 一次执行的**归因**汇总。
 *
 * 「失败 7 条」说明不了任何事：定位不到控件、断言不成立、模型服务坏掉，是三件性质完全
 * 不同的事——第一件是执行器够不着，第二件才是被测产品或用例的问题，第三件根本不该算进
 * 这批结论。原来这份报告只给一个通过数，读的人要逐条展开才看得出自己在看什么。
 */
function Attribution({results}:{results:Result[]}){
  const t=useT();
  const by:Record<string,number>={};
  for(const r of results){
    if(!r.caseId)continue;
    const f=(r.failure??{}) as Result;
    const key=r.status==='passed'?'passed':r.status==='not_run'?'not_run':r.infraError?'infra':String(f.attribution??f.code??r.status??'failed');
    by[key]=(by[key]??0)+1;
  }
  const tone=(k:string)=>k==='passed'?'text-ok':k==='infra'||k==='not_run'?'text-warn':'text-bad';
  const label=(k:string)=>k==='passed'?t('workflow.status.passed'):k==='not_run'?t('workflow.status.not_run'):k==='infra'?t('bench.attr.infra'):k==='locate'?t('bench.attr.locate'):k==='assert'?t('bench.attr.assert'):k;
  return <div className="flex flex-wrap gap-2">{Object.entries(by).sort((a,b)=>b[1]-a[1]).map(([k,n])=>
    <span key={k} className={`rounded border border-border px-2 py-1 text-xs ${tone(k)}`}>{label(k)} · {n}</span>)}</div>;
}
export function ExecutionReport({data}:{data:Record<string,unknown>}){const t=useT(),results=(Array.isArray(data.results)?data.results:[]) as Result[];return <div className="space-y-5"><div className="space-y-3 rounded-lg border border-border bg-card p-5"><div className="flex flex-wrap items-center gap-6"><strong className={data.status==='passed'?'text-ok':'text-bad'}>{t(`workflow.status.${data.status}`)}</strong><span className="text-sm">{t('workflow.status.passed')} · {results.filter(r=>r.status==='passed').length}/{results.filter(r=>r.caseId&&r.status!=='not_run').length}{results.some(r=>r.status==='not_run')&&<span className="ml-2 text-warn">{t('workflow.status.not_run')} {results.filter(r=>r.status==='not_run').length}</span>}</span><span className="font-mono text-xs text-muted-foreground">{String(data.startedAt??'')} → {String(data.finishedAt??'')}</span></div><Attribution results={results}/><p className="text-xs text-muted-foreground">{t('bench.attr.hint')}</p></div>{[...results].sort((a,b)=>(Number(a.status==='not_run')-Number(b.status==='not_run'))||(Number(a.status==='passed')-Number(b.status==='passed'))).map((r,i)=>{const oracle=(Array.isArray(r.oracle)?r.oracle:[]) as Result[],shots=(Array.isArray(r.pngPaths)?r.pngPaths:[]).map(imageUrl).filter((s):s is string=>!!s),failure=(r.failure??{}) as Result;return <details key={String(r.caseId??i)} className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">{String(r.caseId??'—')} <span className={`ml-2 ${r.status==='passed'?'text-ok':r.infraError?'text-warn':'text-bad'}`}>{t(`workflow.status.${r.infraError?'infra_error':r.status??data.status}`)}</span>{typeof r.durationMs==='number'&&<span className="ml-3 font-mono text-xs text-muted-foreground">{(r.durationMs/1000).toFixed(1)} s</span>}</summary>{r.caseId!=null&&<button className="mt-3 text-xs text-primary underline" onClick={()=>navigateProject('review',{caseId:String(r.caseId),revisionId:'',nodeId:'',scope:''})}>{t('bench.reviewCase')}</button>}{r.entryUrl!=null&&<p className="mt-3 break-words font-mono text-xs text-muted-foreground">{String(r.entryUrl)}</p>}{!!(r.failureReason||r.error)&&<p role="status" className="mt-3 whitespace-pre-wrap break-words text-sm text-bad">{String(failure.code??'')}{failure.attribution!=null&&<span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">{String(failure.attribution)}</span>} · {String(r.failureReason??r.error).split('\n')[0]}</p>}<ul className="mt-3 space-y-3 text-sm">{oracle.map((o,k)=><li key={k} className="rounded bg-muted/40 p-3"><p>{String(o.assertion??'')}</p><p className="mt-1 text-xs text-muted-foreground">{String(o.decidedBy??'')} · {String(o.status??'')} · {String(o.detail??'')}</p></li>)}</ul>{shots.length>0&&<div className="mt-4 grid gap-3 sm:grid-cols-2">{shots.map((url,k)=><a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} loading="lazy" alt={`${String(r.caseId)} · ${k+1}`} className="w-full rounded border border-border"/></a>)}</div>}<details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('workflow.evidence')}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(r,null,2)}</pre></details></details>;})}</div>;}
