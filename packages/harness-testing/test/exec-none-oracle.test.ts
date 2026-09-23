import {it,expect,vi,beforeEach} from 'vitest';
const f=vi.hoisted(()=>({calls:[] as string[],fail:false,cleanupFail:false,launchFail:false,actionFail:false,requests:[] as {forwarded:boolean}[]}));
vi.mock('../src/exec/session.js',()=>({launchSession:async()=>{if(f.launchFail)throw new Error("Browser has disconnected");return ({
 page:{url:()=> 'https://example.test/',screenshot:async()=>Buffer.from('png'),evaluate:async(fn:Function)=>fn.toString().includes('.split(')?['Ready']:'Ready'},
 agent:{aiAction:async(t:string)=>{f.calls.push('act:'+t);f.requests.push({forwarded:true});if(f.actionFail)throw new Error('cannot find target');},aiAssert:async(t:string)=>{f.calls.push('assert:'+t);if(f.fail)throw new Error('Assertion failed: missing content');}},
 cleanup:async()=>{if(f.cleanupFail)throw new Error("cleanup secret failure");},modelRequests:f.requests
});},reopenPage:vi.fn()}));
vi.mock('../src/exec/pageReady.js',()=>({settleOn:async()=>({settled:true,controls:1,textLen:5,ms:0})}));
vi.mock('../src/baselines/perf.js',()=>({capturePerf:async()=>({})}));
import {executeRun,releaseRunSession} from '../src/exec/run.js';
beforeEach(()=>{f.calls=[];f.fail=false;f.cleanupFail=false;f.launchFail=false;f.actionFail=false;f.requests=[];});
const model={baseUrl:'https://fixture.test',apiKey:'fixture',model:'fixture'} as never;
it('sends top-level and per-step none oracles to the screen judge alongside machine checks',async()=>{
 const result=await executeRun('https://example.test/',['Open','Close'],'Final screen',{executorModel:model,oracle:{kind:'none'},assertions:[
 {statement:'Dialog visible',afterStep:1,oracle:{kind:'none'}},{statement:'Final visible',oracle:{kind:'none'}},{statement:'same URL',oracle:{kind:'url',value:'example.test'}}
 ]});
 expect(result.status).toBe('passed');expect(f.calls).toEqual(['act:Open','assert:Dialog visible','act:Close','assert:Final screen','assert:Final visible']);
 expect(result.oracle.filter(o=>o.decidedBy==='judge')).toHaveLength(3);
});
it('does not turn a failed visual assertion into passed or unobservable',async()=>{
 f.fail=true;
 const result=await executeRun('https://example.test/',['Open'],'Visible',{executorModel:model,oracle:{kind:'none'},assertions:[{statement:'same URL',oracle:{kind:'url',value:'example.test'}}]});
 expect(result.status).toBe('failed');expect(result.oracle.some(o=>o.decidedBy==='judge'&&o.status==='fail')).toBe(true);
});
it('checks prerequisites in the same session before test actions and returns observations',async()=>{
 const result=await executeRun('https://example.test/',['Submit test'],'Expected',{executorModel:model,captureObservations:true,preparation:{steps:['Open settings'],checks:['Correct account']}});
 expect(f.calls).toEqual(['act:Open settings','assert:Correct account','act:Submit test','assert:Expected']);
 expect(result.prerequisiteChecks).toMatchObject([{statement:'Correct account',status:'pass',evidence:[{kind:'screen',source:'page:visual-assertion'}]}]);
 expect(result.observations?.map(o=>o.step)).toEqual([0,-1,1]);
});
it('stops before business actions when a prerequisite fails, retaining the observed location',async()=>{
 f.fail=true;
 const result=await executeRun('https://example.test/',['Submit order'],'Expected',{executorModel:model,captureObservations:true,preparation:{steps:['Open account'],checks:['Funded account']}});
 expect(result.status).toBe('failed');expect(result.failureReason).toContain('PREREQUISITE_NOT_VERIFIED');
 expect(f.calls).not.toContain('act:Submit order');expect(result.prerequisiteChecks?.[0].status).toBe('fail');expect(result.observations?.at(-1)?.url).toBe('https://example.test/');
});

it('uses runtime facts for a mixed environment prerequisite without asking the screenshot model to guess',async()=>{
 const result=await executeRun('https://example.test/',['Submit test'],'Expected',{executorModel:model,preparation:{steps:[],checks:[{statement:'Target and current page are ready',checks:[
 {kind:'environment',fact:'target-origin',expected:'https://example.test'}, {kind:'screen',statement:'Ready',oracle:{kind:'text',value:'Ready'}}
 ]}]}});
 expect(result.status).toBe('passed');expect(f.calls).toEqual(['act:Submit test','assert:Expected']);
 expect(result.environmentFacts).toContainEqual(expect.objectContaining({fact:'authentication',source:'runner:configured-session-checks'}));
});
it('unconfigured authentication and unavailable historical conditions are unknown and stop business actions',async()=>{
 const result=await executeRun('https://example.test/',['Submit test'],'Expected',{executorModel:model,preparation:{steps:[],checks:[{statement:'Authenticated and funded',checks:[
 {kind:'environment',fact:'authentication',expected:true},{kind:'unknown',reason:'Historical baseline unavailable'}
 ]}]}});
 expect(result.status).toBe('unobservable');expect(result.prerequisiteChecks?.[0].status).toBe('unknown');expect(f.calls).toEqual([]);
});
it('runs auxiliary assertions at their declared step and never skips original acceptance',async()=>{
 const result=await executeRun('https://example.test/',['Transfer','Close'],'Original acceptance',{executorModel:model,preparation:{steps:[],checks:[],auxiliaryAssertions:[{id:'total',statement:'Total conserved',supports:['$expected'],afterStep:1}]}});
 expect(result.status).toBe('passed');expect(f.calls).toEqual(['act:Transfer','assert:Total conserved','act:Close','assert:Original acceptance']);
});
it('rechecks recipe entry and postconditions around setup in every browser session',async()=>{
 const recipe={capability:'account.open-panel',requires:['Panel ready'],entryChecks:[{statement:'Entry ready',checks:[{kind:'screen' as const,statement:'Entry ready'}]}],steps:['Open panel'],postconditions:[{statement:'Panel ready',checks:[{kind:'screen' as const,statement:'Panel ready'}]}],sideEffects:'ui-only' as const,cleanup:[]};
 for(let n=0;n<2;n++){
 f.calls=[];
 const result=await executeRun('https://example.test/',['Read'],'Expected',{executorModel:model,preparation:{steps:recipe.steps,checks:[],recipe}});
 expect(result.status).toBe('passed');expect(result.recipeChecks?.map(c=>[c.phase,c.status])).toEqual([['entry','pass'],['postcondition','pass']]);
 expect(f.calls).toEqual(['assert:Entry ready','act:Open panel','assert:Panel ready','act:Read','assert:Expected']);
 }
});

it('preserves visual acceptance when a supplementary machine check is added',async()=>{
 const result=await executeRun('https://example.test/',['Submit'],'Original summary',{executorModel:model,assertions:[{id:'original',statement:'Original detailed acceptance'}],preparation:{steps:[],checks:[],auxiliaryAssertions:[{id:'extra',statement:'Supplementary URL',supports:['original'],oracle:{kind:'url',value:'wrong.test'}}]}});
 expect(f.calls).toEqual(['act:Submit','assert:Original summary','assert:Original detailed acceptance']);
 expect(result.status).toBe('failed');expect(result.failureReason).toContain('AUXILIARY_CHECK_NOT_VERIFIED');expect(result.failure?.attribution).toBe('infra');
 expect(result.oracle.map(c=>c.assertion)).toEqual(['Original summary','Original detailed acceptance']);expect(result.auxiliaryChecks?.[0]).toMatchObject({id:'extra',status:'fail'});
});

it('preserves phase evidence, request source and sensitive-field boundaries on failure',async()=>{
 f.actionFail=true;f.cleanupFail=true;
 const r=await executeRun('https://example.test/',['Click'],'Expected',{executorModel:model});
 expect(r.status).toBe('failed');expect(r.failure?.attribution).toBe('locate');expect(r.failureReason).toBe('cannot find target');
 expect(r.observation?.stages).toContainEqual(expect.objectContaining({stage:'actions',status:'failed',model:{source:'role-proxy',forwarded:1,blocked:0}}));
 expect(r.observation?.stages).toContainEqual(expect.objectContaining({stage:'cleanup',status:'failed'}));
 expect(JSON.stringify(r.observation)).not.toMatch(/example.test|secret|Expected|Click/);
});
it('records unknown preparation without inventing business action or cache evidence',async()=>{
 const r=await executeRun('https://example.test/',['Click'],'Expected',{executorModel:model,preparation:{steps:[],checks:[{statement:'History',checks:[{kind:'unknown',reason:'No baseline'}]}]}});
 expect(r.observation?.stages).toContainEqual(expect.objectContaining({stage:'preparation',status:'unknown'}));
 expect(r.observation?.stages.some(s=>s.stage==='actions')).toBe(false);expect(r.observation?.cache.midscene).toBe('unknown');
});
it('keeps session launch failure usage unavailable and handles cancellation before launch',async()=>{
 f.launchFail=true;const r=await executeRun('https://example.test/',[], '',{executorModel:model});
 expect(r.modelRequests).toBeUndefined();expect(r.observation?.stages[0]).toMatchObject({stage:'session-navigation',status:'failed',model:{forwarded:null,source:'unavailable'}});
 const controller=new AbortController();controller.abort();const cancelled=await executeRun('https://example.test/',[], '',{executorModel:model,signal:controller.signal});
 expect(cancelled.observation?.stages[0].status).toBe('cancelled');
});
it('does not let browser cleanup failure leave a successful run green',async()=>{
 f.cleanupFail=true;const r=await executeRun('https://example.test/',[], '',{executorModel:model});
 expect(r.status).toBe('failed');expect(r.failureReason).toBe('ENV_TEARDOWN_FAILED');
});

it('reports session reuse only at the actual pool branch, with per-run request offsets',async()=>{
 const session=await import('../src/exec/session.js');vi.mocked(session.reopenPage).mockImplementation(async s=>s);
 try {
  const first=await executeRun('https://example.test/',['Open'],'',{executorModel:model,sessionKey:'observation-pool'});
  const second=await executeRun('https://example.test/',['Open'],'',{executorModel:model,sessionKey:'observation-pool'});
  expect(first.observation?.cache.session).toBe('miss');expect(second.observation?.cache.session).toBe('hit');
  expect(first.modelRequests).toHaveLength(1);expect(second.modelRequests).toHaveLength(1);
  expect(second.observation?.stages.reduce((n,s)=>n+(s.model.forwarded??0),0)).toBe(1);
 } finally { await releaseRunSession('observation-pool'); }
});
