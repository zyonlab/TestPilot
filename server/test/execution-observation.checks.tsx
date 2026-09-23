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
