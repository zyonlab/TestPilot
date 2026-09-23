import {it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {translate} from '../../src/lib/i18n';
let lang:'zh'|'en'|'ja'='en';
vi.mock('../../src/lib/prefs',()=>({useT:()=>((key:string)=>translate(key,lang))}));
import {RevisionContent} from '../../src/components/workbench/RevisionViewer';
import {evaluateExplorationResult} from '../src/explorationResults.js';
import {ExplorationCharterSchema,buildExplorationReport} from '@testpilot/harness-testing/domain';
import {StateFlowGraphSchema} from '@testpilot/harness-testing/exec';

const graph=StateFlowGraphSchema.parse({entry:'entry',states:[{id:'entry',route:'/',controls:['button: Open']},{id:'panel',route:'/',controls:['button: Close']}],transitions:[{from:'entry',to:'panel',action:{kind:'click',target:'Open',selector:'#open'},ok:true,walked:true}],unvisited:['/unvisited']});
const charter=ExplorationCharterSchema.parse({schemaVersion:'exploration-charter.v1',id:'scope',rulePack:{id:'rules',version:'1',hash:'a'.repeat(64)},scope:{entryUrl:'https://example.test/',routes:['/']},featureTargets:[{id:'open',featureId:'panel',match:{label:['Open']},action:'activate',sideEffect:'ui-only'}],budgets:{maxScreens:8}});
const report=()=>buildExplorationReport({charter,graph,targets:[{stableId:'open-button',targetSpecId:'open',featureId:'panel',stateId:'entry',route:'/',role:'button',label:'Open',display:'button: Open',selector:'#open',availability:'enabled',foundAtRound:0}],observations:[{id:'obs1',targetId:'open-button',targetSpecId:'open',featureId:'panel',stateBefore:'entry',stateAfter:'panel',status:'attempted',action:{kind:'click',target:'Open',selector:'#open'},round:1,controlsAfter:['button: Close'],evidenceRefs:['sfg:edge:0','sfg:state:panel']}],stop:{kind:'dry'},budget:{maxScreens:8,screens:2,rounds:1,maxRounds:20}});
for(const language of ['zh','en','ja'] as const)it(`service → report → UI: verified evidence, unknown legacy and generic scope (${language})`,()=>{
 lang=language;
 const result=evaluateExplorationResult({url:charter.scope.entryUrl,graph,report:report(),stopped:{kind:'screenCap',n:8}},charter);
 expect(result.assessment?.status).toBe('partial');
 const html=renderToStaticMarkup(<RevisionContent kind="report" content={result.report}/>);
 for(const key of ['boundary','denominator','interactionCompleted','not_collected','screenCap','partial'])expect(html).toContain(translate('exploration.evidence.'+key,lang));
 expect(html).toContain('sfg:edge:0');expect(html).toContain('obs1');expect(html).toContain('/unvisited');
 const old={...report(),assessment:undefined,completion:'complete'};
 const original=JSON.stringify(old);
 const legacy=renderToStaticMarkup(<RevisionContent kind="report" content={old}/>);
 expect(legacy).toContain(translate('exploration.evidence.legacy',lang));expect(JSON.stringify(old)).toBe(original);
 const generic=evaluateExplorationResult({url:charter.scope.entryUrl,graph,stopped:{kind:'dry'}});
 expect(generic.assessment).toMatchObject({status:'unknown',scope:{denominator:null}});
 const ordinary=renderToStaticMarkup(<RevisionContent kind="report" content={generic}/>);
 expect(ordinary).toContain(translate('exploration.evidence.scope_undeclared',lang));
});
it('server replaces forged complete assessment and rejects a report from another charter',()=>{
 const forged=report();forged.observations[0].evidenceRefs=['sfg:edge:999'];forged.completion='complete';
 const result=evaluateExplorationResult({url:charter.scope.entryUrl,graph,report:forged,stopped:{kind:'dry'}},charter);
 expect(result.assessment?.status).toBe('partial');expect(result.assessment?.counts.interactionCompleted).toBe(0);
 expect(()=>evaluateExplorationResult({url:charter.scope.entryUrl,graph,report:{...report(),charterId:'other'}},charter)).toThrow('scope_mismatch');
});
it('partial without a graph keeps unknown evidence instead of inventing an empty graph or a completion',()=>{
 const result=evaluateExplorationResult({url:charter.scope.entryUrl,graph:undefined,partial:true},charter);
 expect(result.assessment).toMatchObject({status:'unknown',progress:null,stop:{kind:'failed'}});
 expect(result.assessment?.targets[0].reason).toBe('evidence_not_collected');
});
