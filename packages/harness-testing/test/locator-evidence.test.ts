import {expect,it,vi} from 'vitest';
import {locatorHints,validateLocator,LOCATOR_TTL,type LocatorContext} from '../src/exec/locators.js';
import {buildExplorationReport,ExplorationCharterSchema} from '../src/domain/index.js';
import {StateFlowGraphSchema} from '../src/exec/sfg.js';
const live=vi.hoisted(()=>({result:{} as any}));
vi.mock('../src/exec/locatorEvidence.js',async original=>({...await original<typeof import('../src/exec/locatorEvidence.js')>(),inspectLocator:async()=>live.result}));
const url='https://example.test/',at=new Date().toISOString();
const attempt={attemptId:'91d6725e-d5d2-4f10-b274-9d8e4b87bb8d',projectId:'p',runId:'r',entryUrl:url,scopeHash:'scope',startedAt:at,environmentHash:'env',pageVersion:'build',inputFingerprint:'inputs'};
const evidence={capturedAt:at,url,label:'Open',selector:'#open',role:'button',region:'BODY',stateDigest:'state'};
function fixture(){
 const graph=StateFlowGraphSchema.parse({states:[{id:'before',route:'/',controls:['Open']},{id:'after',route:'/',controls:['Close']}],transitions:[{from:'before',to:'after',action:{kind:'click',target:'Open',selector:'#open'},ok:true}]});
 const charter=ExplorationCharterSchema.parse({schemaVersion:'exploration-charter.v1',id:'scope',rulePack:{id:'rules',version:'1',hash:'a'.repeat(64)},scope:{entryUrl:url},featureTargets:[{id:'open',featureId:'panel',match:{label:['Open']},action:'activate',sideEffect:'ui-only'}],budgets:{maxScreens:8}});
 const report={...buildExplorationReport({charter,graph,targets:[{stableId:'button',targetSpecId:'open',featureId:'panel',stateId:'before',route:'/',role:'button',label:'Open',display:'Open',selector:'#open',availability:'enabled',foundAtRound:0}],observations:[{id:'o',targetId:'button',targetSpecId:'open',featureId:'panel',stateBefore:'before',stateAfter:'after',status:'attempted',action:{kind:'click',target:'Open',selector:'#open'},round:1,controlsAfter:['Close'],evidenceRefs:['sfg:edge:0'],locatorEvidence:{...evidence}}],stop:{kind:'dry'},budget:{maxScreens:8,screens:2,rounds:1,maxRounds:20}}),sourceAttempt:{...attempt}};
 const input={graph,charter,attempt:{...attempt},sourceRevision:'rev'};return {report,input};
}
it('extracts a traced successful low-impact interaction, retaining observation/edge/state',()=>{
 const {report,input}=fixture();expect(locatorHints(report,input)[0]).toMatchObject({label:'Open',source:{revision:'rev',observation:'o',edge:'sfg:edge:0',state:'before'}});
});
it.each(['failed','blocked','no-graph','model-only','missing-after','state-change','expired','future','missing-environment','missing-page-version','missing-inputs','other-run','disabled','no-target','selector-changed'])('rejects %s instead of trusting narrative success',fault=>{
 const {report,input}=fixture(),o=report.observations[0];
 if(fault==='failed'||fault==='blocked')o.status=fault;
 if(fault==='no-graph')input.graph.transitions=[];
 if(fault==='model-only'){o.evidenceRefs=[];report.assessment!.counts.interactionCompleted=1;}
 if(fault==='missing-after')input.graph.states.pop();
 if(fault==='state-change')input.charter.featureTargets[0].sideEffect='state-change';
 if(fault==='expired')o.locatorEvidence!.capturedAt=new Date(Date.now()-LOCATOR_TTL-1).toISOString();
 if(fault==='future')o.locatorEvidence!.capturedAt=new Date(Date.now()+100000).toISOString();
 if(fault==='missing-environment')input.attempt.environmentHash='';
 if(fault==='missing-page-version')input.attempt.pageVersion='';
 if(fault==='missing-inputs')input.attempt.inputFingerprint='';
 if(fault==='other-run')input.attempt.runId='elsewhere';
 if(fault==='disabled')report.targets[0].availability='disabled';
 if(fault==='no-target')report.targets=[];
 if(fault==='selector-changed')o.action!.selector='#other';
 expect(locatorHints(report,input)).toEqual([]);
});
function context(){const f=fixture();const hints=locatorHints(f.report,f.input);return {version:1,trust:'untrusted-data',notice:'untrusted',digest:'digest',hints,rejected:[],scope:{projectId:'p',runId:'r',entryUrl:url,environmentHash:'env',pageVersion:'build',materialsHash:'materials',inputFingerprint:'inputs'}} satisfies LocatorContext;}
it.each(['projectId','runId','entryUrl','environmentHash','pageVersion','materialsHash','loggedOut'] as const)('checks actual runtime %s independently of frozen hint scope',async key=>{
 const c=context(),runtime={...c.scope,loggedOut:false};(runtime as any)[key]=key==='loggedOut'?true:'other';
 expect(await validateLocator({evaluate:()=>{}},c.hints[0],c,runtime)).toBe('dispatch_environment_changed');
});
it.each(['hidden','disabled','not_unique','not_actionable','label','region','role','url','stateDigest'])('falls back before action when %s changes',async reason=>{
 const c=context();live.result=['label','region','role','url','stateDigest'].includes(reason)?{ok:true,evidence:{...evidence,[reason]:'changed'}}:{ok:false,reason};
 expect(await validateLocator({evaluate:()=>{}},c.hints[0],c,{...c.scope,loggedOut:false})).toBe(live.result.ok?reason+'_changed':reason);
});
