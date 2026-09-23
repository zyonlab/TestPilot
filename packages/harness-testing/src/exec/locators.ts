import type { ExplorationReport } from '../domain/report.js';
import type { ExplorationCharter } from '../domain/charter.js';
import { ExplorationAttemptSchema, sameExplorationAttempt, type ExplorationAttempt } from '../domain/explorationEvidence.js';
import { pathOf } from './sfg.js';
import type { StateFlowGraph } from './sfg.js';
import { inspectLocator, LocatorEvidenceSchema, type LocatorEvidence, type LocatorPage } from './locatorEvidence.js';

export const LOCATOR_TTL=7*86400_000;
export interface LocatorHint {
  label:string; selector:string; featureId?:string;
  evidence?:LocatorEvidence;
  source?:{revision:string;observation:string;edge:string;state:string;attempt:ExplorationAttempt};
}
export interface LocatorContext {
  version:1; trust:'untrusted-data'; notice:string; digest:string; sourceRevision?:string;
  scope?:{projectId:string;runId:string;entryUrl:string;environmentHash:string;pageVersion:string;materialsHash:string;inputFingerprint:string};
  hints:LocatorHint[]; rejected:Array<{observation?:string;reason:string}>;
}
export type LocatorRuntimeScope={projectId:string;runId:string;entryUrl:string;environmentHash:string|null;pageVersion:string|null;materialsHash:string|null;loggedOut:boolean};
export interface LocatorReuseReceipt {context:LocatorContext|null;events:Array<{label?:string;source?:LocatorHint['source'];status:'used'|'fallback'|'action-error';reason:string}>}

/** A model's claim or a selector alone is never reusable interaction evidence. */
export function locatorHints(report:Pick<ExplorationReport,'observations'>,input?:{
  graph:StateFlowGraph;charter:ExplorationCharter;attempt:ExplorationAttempt;sourceRevision:string;now?:number;
}):LocatorHint[]{
  if(!input||!input.attempt.environmentHash||!input.attempt.pageVersion||!input.attempt.inputFingerprint)return [];
  const {graph,charter,attempt,sourceRevision}=input, now=input.now??Date.now();
  if(!sameExplorationAttempt((report as ExplorationReport).sourceAttempt,attempt))return [];
  return report.observations.flatMap(o=>{
    const spec=charter.featureTargets.find(t=>t.id===o.targetSpecId&&t.featureId===o.featureId);
    const evidence=LocatorEvidenceSchema.safeParse(o.locatorEvidence);
    if(o.status!=='attempted'||o.action?.kind!=='click'||!spec||spec.action!=='activate'||!['none','ui-only'].includes(spec.sideEffect)||!evidence.success)return [];
    const e=evidence.data, age=now-Date.parse(e.capturedAt);
    if(age<0||age>LOCATOR_TTL||Date.parse(e.capturedAt)<Date.parse(attempt.startedAt)||e.label!==o.action.target||e.selector!==o.action.selector)return [];
    const state=graph.states.find(s=>s.id===o.stateBefore);
    if(!state||state.route!==pathOf(e.url)||!graph.states.some(s=>s.id===o.stateAfter))return [];
    const edge=o.evidenceRefs.find(ref=>{
      if(!/^sfg:edge:\d+$/.test(ref))return false;
      const t=graph.transitions[Number(ref.slice(9))];
      return t?.walked===true&&t.ok&&t.from===o.stateBefore&&t.to===o.stateAfter&&t.action.kind==='click'&&t.action.target===e.label&&t.action.selector===e.selector;
    });
    const target=(report as ExplorationReport).targets?.find(t=>t.stableId===o.targetId&&t.stateId===o.stateBefore&&t.selector===e.selector&&t.label===e.label&&t.availability==='enabled');
    if(!edge||!target||!state.controls.includes(target.display))return [];
    return [{label:e.label,selector:e.selector,featureId:o.featureId,evidence:e,source:{revision:sourceRevision,observation:o.id,edge,state:o.stateBefore,attempt}}];
  });
}
const CLICK_VERB=/点击|点开|点选|勾选|选择|展开|切到|切换到|click|check|select|expand/gi;
export function matchingLocators(step:string,hints:LocatorHint[]):LocatorHint[]{
  CLICK_VERB.lastIndex=0;let end=-1;
  for(let m=CLICK_VERB.exec(step);m;m=CLICK_VERB.exec(step))end=m.index+m[0].length;
  if(end<0)return [];
  const tail=step.slice(end),matched=hints.filter(h=>h.label&&tail.includes(h.label)).sort((a,b)=>b.label.length-a.label.length);
  return matched.filter(h=>h.label.length===matched[0]?.label.length);
}
/** Do not last-wins merge identical labels from different states/regions. */
export function pickLocator(step:string,hints:LocatorHint[]):LocatorHint|undefined{
  const matches=matchingLocators(step,hints);return matches.length===1?matches[0]:undefined;
}
export function locatorUsable(label:string,count:number,text:string):{ok:true}|{ok:false;why:string}{
  if(count!==1)return {ok:false,why:`不唯一（命中 ${count} 个）`};
  if(text.trim()!==label.trim())return {ok:false,why:`已过时（这里现在是「${text.trim().slice(0,24)}」）`};
  return {ok:true};
}
/** Read-only validation ends before the irreversible boundary: caller must never retry a click exception. */
export async function validateLocator(page:LocatorPage,hint:LocatorHint,context?:LocatorContext,runtime?:LocatorRuntimeScope,now=Date.now()):Promise<string|undefined>{
  const a=hint.source?.attempt,s=context?.scope,e=hint.evidence;
  if(!runtime)return 'dispatch_identity_unknown';
  if(!a||!ExplorationAttemptSchema.safeParse(a).success||!a.environmentHash||!a.pageVersion||!a.inputFingerprint||!s?.materialsHash||!e||!LocatorEvidenceSchema.safeParse(e).success||!context?.hints.some(h=>JSON.stringify(h)===JSON.stringify(hint)))return 'metadata_unknown';
  if(runtime.loggedOut||runtime.environmentHash!==s.environmentHash||runtime.pageVersion!==s.pageVersion||runtime.materialsHash!==s.materialsHash||runtime.entryUrl!==s.entryUrl||runtime.projectId!==s.projectId||runtime.runId!==s.runId)return 'dispatch_environment_changed';
  if(a.projectId!==s.projectId||a.runId!==s.runId||a.entryUrl!==s.entryUrl||a.environmentHash!==s.environmentHash||a.pageVersion!==s.pageVersion||a.inputFingerprint!==s.inputFingerprint)return 'scope_mismatch';
  if(now-Date.parse(e.capturedAt)>LOCATOR_TTL||now<Date.parse(e.capturedAt))return 'expired';
  const current=await inspectLocator(page,hint.selector);
  if(!current.ok)return current.reason;
  for(const key of ['url','label','role','region','stateDigest'] as const)if(current.evidence[key]!==e[key])return `${key}_changed`;
}
