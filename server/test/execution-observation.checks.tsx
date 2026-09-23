import {it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {translate} from '../../src/lib/i18n';
const state=vi.hoisted(()=>({lang:'zh' as 'zh'|'en'|'ja'}));
vi.mock('../../src/lib/prefs',()=>({useT:()=> (key:string,vars?:Record<string,string|number>)=>translate(key,state.lang,vars)}));
import {ExecutionObservation} from '../../src/components/workbench/ExecutionObservation';
import {RevisionContent} from '../../src/components/workbench/RevisionViewer';
it('renders actual translated failure, unknown usage, attempts and legacy receipts in three languages',()=>{
 const value={version:1,stages:[{stage:'preparation',durationMs:1500,status:'failed',model:{source:'unavailable',forwarded:null,blocked:null},failure:{attribution:'infra',retryable:false}}],cache:{session:'unavailable',midscene:'unknown'},retries:[{stage:'actions',reason:'coordinate-replay',delayMs:0}]};
 for(const lang of ['zh','en','ja'] as const){
  state.lang=lang;
  const html=renderToStaticMarkup(<ExecutionObservation value={value}/>);
  expect(html).toContain('1.50');expect(html).toContain(translate('observation.stage.preparation',lang));expect(html).toContain(translate('observation.cache.unknown',lang));expect(html).not.toContain('observation.');
  expect(renderToStaticMarkup(<ExecutionObservation value={undefined}/>)).toContain(translate('observation.missing',lang));
  expect(renderToStaticMarkup(<RevisionContent kind="report" content={{status:'failed',logs:[]}}/>)).toContain(translate('observation.missing',lang));
  const cancelled=renderToStaticMarkup(<ExecutionObservation value={null} attempts={[{attempt:1,status:'cancelled',durationMs:2500,observation:null}]}/>);
  expect(cancelled).toContain('2.50');expect(cancelled).toContain(translate('workflow.status.cancelled',lang));
  const unknown=renderToStaticMarkup(<ExecutionObservation value={null} attempts={[{attempt:1,status:'unknown',durationMs:10,observation:null}]}/>);expect(unknown).toContain(translate('workflow.unknown',lang));expect(unknown).not.toContain('workflow.status.unknown');
  const receipt=renderToStaticMarkup(<RevisionContent kind="report" content={{status:'failed',observation:value,prerequisiteChecks:[]}}/>);
  expect(receipt).toContain(translate('observation.stage.preparation',lang));
 }
});

import {LifecycleDetail} from '../../src/components/workbench/LifecycleDetail';
it('renders lifecycle obligations, pending resources and not-run evidence in three languages',()=>{
 const c={version:1,mode:'read-only',rationale:'Read screen',sourceRefs:['spec#1'],supports:['$expected'],baseline:[{statement:'Ready',checks:[{kind:'screen',statement:'Ready',oracle:{kind:'text',value:'Ready'}}]}],resources:[],cleanup:[]};
 const r={version:1,status:'unknown',checks:[],cleanup:[{id:'clean',postStep:1,status:'not-run',detail:'Session closed'}],pendingResources:[{id:'r1',identity:'run-owned-123',reason:'Cancelled'}],safeToRetry:false};
 for(const lang of ['zh','en','ja'] as const){state.lang=lang;
  const html=renderToStaticMarkup(<LifecycleDetail contract={c} value={r} receipt/>);
  expect(html).toContain('run-owned-123');expect(html).toContain(translate('lifecycle.status.not-run',lang));expect(html).toContain(translate('lifecycle.pending',lang));expect(html).not.toContain('lifecycle.');
  expect(renderToStaticMarkup(<LifecycleDetail/>)).toContain(translate('lifecycle.unknown',lang));
  const prep=renderToStaticMarkup(<RevisionContent kind="report" content={{status:'failed',logs:[],lifecycle:r}}/>);expect(prep).toContain('run-owned-123');
 }
});
it('fails closed on malformed lifecycle artifacts without crashing or duplicating unknown',()=>{
 state.lang='en';
 const html=renderToStaticMarkup(<LifecycleDetail contract={{version:1,resources:{}}} value={{version:1,checks:'bad',cleanup:{}}} receipt/>);
 expect(html.split(translate('lifecycle.unknown','en'))).toHaveLength(2);
});
