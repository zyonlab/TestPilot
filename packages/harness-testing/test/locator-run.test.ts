import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({text:'Ready',clicks:0,model:0,throwClick:false,same:true,inspect:{} as any}));
vi.mock('../src/exec/locatorEvidence.js',async original=>({...await original<typeof import('../src/exec/locatorEvidence.js')>(),inspectLocator:async()=>f.inspect}));
vi.mock('../src/exec/session.js',()=>({launchSession:async()=>({page:{url:()=> 'https://example.test/',isClosed:()=>false,screenshot:async()=>Buffer.from('png'),$$:async()=>[{click:async()=>{f.clicks++;f.text='Panel visible';if(f.throwClick)throw new Error('click completed then disconnected');}}],evaluate:async(fn:Function)=>fn.toString().includes('isConnected')?f.same:fn.toString().includes('.split(')?['Ready']:f.text},agent:{aiAction:async()=>{f.model++;f.text='Panel visible';},aiAssert:async()=>{}},cleanup:async()=>{},modelRequests:[]}),reopenPage:vi.fn()}));
vi.mock('../src/exec/pageReady.js',()=>({settleOn:async()=>({settled:true,controls:1,textLen:5,ms:0})}));
vi.mock('../src/baselines/perf.js',()=>({capturePerf:async()=>({})}));
import {executeRun} from '../src/exec/run.js';
const at=new Date().toISOString(),url='https://example.test/';
const evidence={capturedAt:at,url,label:'Open',selector:'#open',role:'button',region:'BODY',stateDigest:'state'};
const attempt={attemptId:'91d6725e-d5d2-4f10-b274-9d8e4b87bb8d',projectId:'p',runId:'r',entryUrl:url,scopeHash:'scope',startedAt:at,environmentHash:'env',pageVersion:'build',inputFingerprint:'inputs'};
const hint={label:'Open',selector:'#open',evidence,source:{revision:'source',observation:'obs',edge:'sfg:edge:0',state:'before',attempt}};
const scope={projectId:'p',runId:'r',entryUrl:url,environmentHash:'env',pageVersion:'build',materialsHash:'materials',inputFingerprint:'inputs'};
const opts=()=>({executorModel:{endpoint:'http://fixture.test',apiKey:'fixture',model:'fixture',role:'executor'} as never,oracle:{kind:'text' as const,value:'Panel visible'},locatorContext:{version:1 as const,trust:'untrusted-data' as const,notice:'untrusted',digest:'digest',scope,hints:[structuredClone(hint)],rejected:[]},locatorRuntimeScope:{...scope,loggedOut:false}});
beforeEach(()=>{f.text='Ready';f.clicks=0;f.model=0;f.throwClick=false;f.same=true;f.inspect={ok:true,evidence};});
it('enabled / disabled hints retain identical business oracle; records actual adapter invocations separately',async()=>{
 const enabled=await executeRun(url,['Click Open'],'Panel visible',opts());expect(enabled.status).toBe('passed');expect(f.model).toBe(0);expect(f.clicks).toBe(1);expect(enabled.evidenceReuse?.events[0].status).toBe('used');
 f.text='Ready';const disabled=await executeRun(url,['Click Open'],'Panel visible',{...opts(),locatorContext:undefined});expect(disabled.status).toBe('passed');expect(f.model).toBe(1);expect(disabled.oracle.map(x=>x.status)).toEqual(enabled.oracle.map(x=>x.status));expect(disabled.evidenceReuse?.events[0].status).toBe('fallback');
});
it('click effect then exception is attempted exactly once and never followed by a model action',async()=>{
 f.throwClick=true;const r=await executeRun(url,['Click Open'],'Panel visible',opts());expect(r.status).toBe('failed');expect(f.clicks).toBe(1);expect(f.model).toBe(0);expect(r.lifecycle?.safeToRetry).toBe(false);expect(r.evidenceReuse?.events).toContainEqual(expect.objectContaining({status:'action-error',reason:'action_attempted_no_retry'}));
});
it('replaced target between read and action falls back before click',async()=>{
 f.same=false;const r=await executeRun(url,['Click Open'],'Panel visible',opts());expect(r.status).toBe('passed');expect(f.clicks).toBe(0);expect(f.model).toBe(1);expect(r.evidenceReuse?.events[0].reason).toBe('target_changed');
});
it('environment changes after context delivery preserve frozen content and reject before action',async()=>{
 const o=opts(),before=JSON.stringify(o.locatorContext);o.locatorRuntimeScope.environmentHash='new-secret';const r=await executeRun(url,['Click Open'],'Panel visible',o);expect(r.status).toBe('passed');expect(f.clicks).toBe(0);expect(f.model).toBe(1);expect(r.evidenceReuse?.events[0].reason).toBe('dispatch_environment_changed');expect(JSON.stringify(o.locatorContext)).toBe(before);
});
it('same-label candidates do not silently overwrite region identity',async()=>{
 const o=opts();o.locatorContext.hints.push({...hint,selector:'#other',evidence:{...evidence,region:'OTHER'}});const r=await executeRun(url,['Click Open'],'Panel visible',o);expect(f.clicks).toBe(0);expect(f.model).toBe(1);expect(r.evidenceReuse?.events[0].reason).toBe('ambiguous_label');
});
