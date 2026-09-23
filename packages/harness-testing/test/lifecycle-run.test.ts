import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({text:'Ready',calls:[] as string[],fail:'',closed:false,cleanupFails:false,abort:undefined as AbortController|undefined}));
vi.mock('../src/exec/session.js',()=>({launchSession:async()=>({page:{url:()=> 'https://example.test/',isClosed:()=>f.closed,screenshot:async()=>Buffer.from('png'),evaluate:async(fn:Function)=>fn.toString().includes('.split(')?['Ready']:f.text},agent:{aiAction:async(t:string)=>{f.calls.push(t);if(t.startsWith('Create'))f.text+='\n'+t.slice(7)+' owner-A';if(t==='Close browser'){f.closed=true;throw new Error('Target closed');}if(t==='Cancel'){f.abort!.abort();throw new Error('EXEC_CANCELLED');}if(t.startsWith('Delete')){if(f.cleanupFails)throw new Error('cleanup failed');f.text='Ready';}if(t===f.fail)throw new Error('cannot find target');},aiAssert:async()=>{}},cleanup:async()=>{f.closed=true;},modelRequests:[]}),reopenPage:vi.fn()}));
vi.mock('../src/exec/pageReady.js',()=>({settleOn:async()=>({settled:true,controls:1,textLen:5,ms:0})}));
vi.mock('../src/baselines/perf.js',()=>({capturePerf:async()=>({})}));
import {executeRun} from '../src/exec/run.js';
import {LifecycleSchema,lifecycleIssues} from '../src/exec/lifecycle.js';
const identity='test-${env.TP_LIFECYCLE_ID}';
const check=(value:string,kind:'text'|'noText'='text')=>({statement:value,checks:[{kind:'screen' as const,statement:value,oracle:{kind,value}}]});
const lifecycle=()=>LifecycleSchema.parse({version:1,mode:'controlled',rationale:'Creates an isolated resource',sourceRefs:['spec#1'],supports:['$expected'],baseline:[check('Ready')],resources:[{id:'new',sourceRef:'spec#1',identity,establishAfterStep:1,established:check(identity),ownership:check(identity+' owner-A')}],cleanup:[{id:'delete',resourceId:'new',postStep:1,verified:check(identity,'noText')}]});
const opts=()=>({executorModel:{baseUrl:'https://fixture.test',apiKey:'fixture',model:'fixture'} as never,lifecycle:lifecycle(),sourceRefs:['spec#1'],postSteps:['Delete '+identity],oracle:{kind:'text' as const,value:'Ready'}});
beforeEach(()=>{f.text='Ready';f.calls=[];f.fail='';f.closed=false;f.cleanupFails=false;f.abort=undefined;});
it('compensates after an action throws, preserves the original failure and records independent screen proof',async()=>{
 f.fail='Fail';const result=await executeRun('https://example.test',['Create '+identity,'Fail'],'Ready',opts());
 expect(result.status).toBe('failed');expect(result.failureReason).toBe('cannot find target');expect(result.failure?.attribution).toBe('locate');
 expect(f.calls.at(-1)).toMatch(/^Delete test-/);expect(result.lifecycle?.cleanup[0].status).toBe('pass');expect(result.lifecycle?.pendingResources).toEqual([]);expect(result.lifecycle?.safeToRetry).toBe(false);
 expect(result.observation?.stages).toContainEqual(expect.objectContaining({stage:'cleanup',status:'completed'}));
});
it('attempts every cleanup even when several fail and keeps the business error',async()=>{
 f.fail='Fail';f.cleanupFails=true;const options=opts();options.postSteps.push('Delete '+identity);options.lifecycle.cleanup.push({...options.lifecycle.cleanup[0],id:'delete-again',postStep:2});
 const result=await executeRun('https://example.test',['Create '+identity,'Fail'],'Ready',options);
 expect(f.calls.filter(s=>s.startsWith('Delete'))).toHaveLength(2);expect(result.lifecycle?.cleanup.map(x=>x.status)).toEqual(['fail','fail']);expect(result.lifecycle?.pendingResources).toHaveLength(1);expect(result.failureReason).toBe('cannot find target');
});
it('cleanup failure never leaves passed and does not pretend the business verdict failed',async()=>{
 f.cleanupFails=true;const result=await executeRun('https://example.test',['Create '+identity],'Ready',opts());
 expect(result.status).toBe('failed');expect(result.businessStatus).toBe('passed');expect(result.lifecycle?.status).toBe('fail');
});
it('does not clean resources after baseline or prerequisite failure or before their creating step',async()=>{
 f.text='Wrong page';const baseline=await executeRun('https://example.test',['Create '+identity],'Ready',opts());expect(f.calls).toEqual([]);expect(baseline.lifecycle?.cleanup[0].status).toBe('not-run');
 f.text='Ready';const prerequisite=await executeRun('https://example.test',['Create '+identity],'Ready',{...opts(),preparation:{steps:[],checks:[check('Missing')]}});expect(f.calls).toEqual([]);expect(prerequisite.lifecycle?.pendingResources).toEqual([]);
});
it.each(['Close browser','Cancel'])('leaves pending resource evidence after %s without claiming cleanup',async(action)=>{
 const controller=new AbortController();f.abort=controller;
 const result=await executeRun('https://example.test',['Create '+identity,action],'Ready',{...opts(),signal:controller.signal});
 expect(result.status).toBe('failed');expect(f.calls.some(s=>s.startsWith('Delete'))).toBe(false);expect(result.lifecycle?.cleanup[0].status).toBe('not-run');expect(result.lifecycle?.pendingResources).toHaveLength(1);
});
it('withholds cleanup when the observed owner differs',async()=>{
 const options=opts();options.lifecycle.resources[0].ownership=check(identity+' owner-B');
 const result=await executeRun('https://example.test',['Create '+identity],'Ready',options);
 expect(result.status).not.toBe('passed');expect(f.calls.some(s=>s.startsWith('Delete'))).toBe(false);expect(result.lifecycle?.cleanup[0].status).toBe('fail');expect(result.lifecycle?.pendingResources).toHaveLength(1);
});
it('legacy cleanup is attempted after action failure, but success remains unknown',async()=>{
 f.fail='Fail';const {lifecycle:_,...options}=opts();const result=await executeRun('https://example.test',['Fail'],'Ready',options);
 expect(result.failureReason).toBe('cannot find target');expect(f.calls).toHaveLength(2);expect(result.lifecycle?.cleanup[0].status).toBe('unknown');expect(result.lifecycle?.status).toBe('unknown');
});
it('rejects unbound contracts at the direct runner boundary before touching the SUT',async()=>{
 const options=opts();options.lifecycle.cleanup[0].resourceId='foreign';
 const result=await executeRun('https://example.test',['Create '+identity],'Ready',options);
 expect(result.failureReason).toContain('LIFECYCLE_INVALID');expect(f.calls).toEqual([]);
});
it('requires deterministic screen evidence and full source/acceptance/action bindings',()=>{
 expect(()=>LifecycleSchema.parse({...lifecycle(),baseline:[{statement:'Verified',checks:[{kind:'screen',statement:'Verified'}]}]})).toThrow();
 const l=lifecycle();expect(lifecycleIssues({lifecycle:l,steps:['Create '+identity],postSteps:['Delete '+identity],sourceRefs:['spec#1']})).toEqual([]);
 l.supports=['made-up'];expect(lifecycleIssues({lifecycle:l,steps:['Create'],postSteps:[],sourceRefs:[]})).toContain('lifecycle_assertion_unbound');
});
it('rejects mutable preparation outside the controlled contract before any action',async()=>{
 const r=await executeRun('https://example.test',['Create '+identity],'Ready',{...opts(),preparation:{steps:['Create an unrelated resource'],checks:[]}});
 expect(r.failureReason).toBe('LIFECYCLE_UNCONTROLLED_PREPARATION');expect(f.calls).toEqual([]);
});
it('preserves a fresh runtime identity despite user environment override',async()=>{
 const r=await executeRun('https://example.test',['Create '+identity],'Ready',{...opts(),resolve:{env:{TP_LIFECYCLE_ID:'user-chosen'},secrets:{}}});
 expect(r.status).toBe('passed');expect(f.calls.join()).not.toContain('user-chosen');
});

import {runGate} from '../src/casegen/gate.js';
import {TextCaseSchema} from '../src/casegen/types.js';
it('accepts complete short read-only cases without minimum, average or maximum step gates',()=>{
 const c=TextCaseSchema.parse({id:'c',storyId:'s',title:'Read',designMethod:'negative',steps:['Click Read'],expected:'Ready appears',tier:1,oracle:{kind:'text',value:'Ready'},key:'read',sourceRefs:['spec#1'],lifecycle:{version:1,mode:'read-only',rationale:'Read or reject without creating resources',sourceRefs:['spec#1'],supports:['$expected'],baseline:[check('Ready')],resources:[],cleanup:[]}});
 for(const steps of [c.steps,Array(20).fill('Click Read')]){
  const gate=runGate({origin:'fixture',stories:[{id:'s',title:'Read',acceptance:[]}],flows:[],cases:[{...c,steps}]},{minSteps:10,maxSteps:1});
  expect(gate.findings.filter(f=>f.rule==='granularity'||f.rule==='lifecycle')).toEqual([]);
 }
});
