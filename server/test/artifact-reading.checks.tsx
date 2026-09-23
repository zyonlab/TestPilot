import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../src/lib/prefs', () => ({ useT: () => (key:string) => key }));
import { Markdown } from '../../src/components/Markdown';
import { DocumentFields, RulePackDocument, ExplorationDocument } from '../../src/components/workbench/ArtifactDocument';

describe('shared artifact reading', () => {
  it('reads rules from a different domain and retains conditions and evidence', () => {
    const html=renderToStaticMarkup(<RulePackDocument data={{rulePack:{product:'Library',modules:[{id:'loans',name:'Borrowing'}],features:[{id:'renew',name:'Renew loan',moduleId:'loans'}],rules:[{id:'LIB-7',featureIds:['renew'],statement:'Renew only before the due date.',appliesWhen:'No reservation pending',sourceRefs:['handbook'],verification:{question:'Is a late renewal rejected?'}}]}}}/>);
    for(const text of ['Library','Borrowing','Renew only before the due date.','No reservation pending','handbook','Is a late renewal rejected?'])expect(html).toContain(text);
  });
  it('retains unassigned rules and unknown fields including false and zero', () => {
    const html=renderToStaticMarkup(<DocumentFields data={{newField:{enabled:false,count:0},sourceRefs:['source-9'],futureItems:[{name:'Future record',detail:'Do not lose this'}]}}/>);
    for(const text of ['new Field','artifact.no','>0<','source-9','Future record','Do not lose this'])expect(html).toContain(text);
    expect(renderToStaticMarkup(<RulePackDocument data={{rulePack:{rules:[{statement:'Unassigned rule'}]}}}/>)).toContain('Unassigned rule');
  });
  it('keeps partial exploration and missing evidence distinct from success', () => {
    const html=renderToStaticMarkup(<ExplorationDocument data={{completion:'partial',coverage:{targetsAttempted:4,targetsFailed:0},unknowns:['Account unavailable'],stopReason:{kind:'screenCap',n:8}}}/>);
    for(const text of ['partial','Account unavailable','screenCap','artifact.coverageHint'])expect(html).toContain(text);
  });
  it('renders semantic headings, numbered steps and safe links', () => {
    const html=renderToStaticMarkup(<Markdown text={'## Lifecycle\n3. Open\n4. Close\n\n[Docs](https://example.com/docs)\n[unsafe](javascript:alert)\n<script>alert(1)</script>'}/>);
    expect(html).toContain('<h2');expect(html).toContain('<ol');expect(html).toContain('start="3"');
    expect(html).toContain('href="https://example.com/docs"');expect(html).not.toContain('href="javascript:');expect(html).not.toContain('<script>');
  });
});

import { progressNode } from '../../src/components/workbench/progressNode';
describe('workbench progress follows actual activity',()=>{
 const n=(node:string,phase:string,at:string)=>({node,phase,at});
 it('follows the running retry rather than a later graph node',()=>{
  expect(progressNode({status:'running',nodes:[n('cases','running','2026-09-20T12:00:00Z'),n('gate','failed','2026-09-20T11:00:00Z')]})).toBe('cases');
 });
 it('retains the failed node when the run stops',()=>{
  expect(progressNode({status:'failed',nodes:[n('stories','done','2026-09-20T10:00:00Z'),n('cases','failed','2026-09-20T11:00:00Z')]})).toBe('cases');
 });
 it('shows the completed node instead of the next untouched breakpoint',()=>{
  expect(progressNode({status:'paused',nodes:[n('cases','done','2026-09-20T11:00:00Z'),n('gate','blocked','2026-09-20T12:00:00Z')]})).toBe('cases');
 });
 it('handles an empty run',()=>expect(progressNode({status:'registered',nodes:[]})).toBe('source'));
});

import {uniqueKnowledgeRevisions} from '../../src/components/workbench/knowledgeRevisions';
import type {Revision} from '../../src/lib/workflowRuns';
describe('knowledge revision display',()=>{
 const revision=(id:string,name:string,contentHash:string,n:number,runId='run')=>({id,name,contentHash,revision:n,runId,kind:'report'} as Revision);
 it('collapses duplicate bytes to the latest revision independent of input order',()=>{
  const v1=revision('a','knowledge/rulepack/demo','same',1),v2=revision('b','knowledge/rulepack/demo','same',2);
  expect(uniqueKnowledgeRevisions([v1,v2])).toEqual([v2]);
  expect(uniqueKnowledgeRevisions([v2,v1])).toEqual([v2]);
 });
 it('preserves changed content, separate documents, runs, and non-knowledge outputs',()=>{
  const rows=[revision('a','knowledge/rulepack/demo','one',1),revision('b','knowledge/rulepack/demo','two',2),revision('c','knowledge/domain','one',1),revision('d','knowledge/rulepack/demo','one',1,'other'),revision('e','validated/modules','one',1),revision('f','validated/modules','one',2)];
  expect(uniqueKnowledgeRevisions(rows)).toEqual(rows);
 });
});

import {nodeKnowledge} from '../../src/components/workbench/nodeKnowledge';
describe('node input references',()=>{
 const r=(id:string,name:string,sourceRefs:string[]=[],revision=1)=>({id,name,sourceRefs,revision,createdAt:'2026-09-20T10:00:00Z'} as Revision);
 it('includes current shared inputs but excludes upstream-only references',()=>{
  const v1=r('pack1','knowledge/rulepack/p'),v2=r('pack2',v1.name,[],2),domain=r('domain','knowledge/domain-reference'),model=r('model','product/model-candidate',['pack1']),instructions=r('inst','validated/instructions');
  const all=[v1,v2,domain,model,instructions];
  const loaded=[{revision:v1,content:{rulePack:{id:'p',version:'1'}}},{revision:v2,content:{rulePack:{id:'p',version:'1'}}},{revision:domain,content:{text:'Domain'}},{revision:instructions,content:{runScope:{domainReference:'Domain',rulePack:{id:'p',version:'1'}}}}];
  expect(nodeKnowledge('modules',all,loaded,true)).toEqual([{id:'domain',sources:['sharedLegacy']},{id:'pack2',sources:['sharedLegacy']}]);
  expect(nodeKnowledge('modules',all,loaded,false)).toEqual([]);
 });
 it('honors exact shared and direct revisions without selecting newer versions',()=>{
  const pack=r('old','knowledge/rulepack/p'),newer=r('new',pack.name,[],2),manifest=r('ctx','context/stories'),instructions=r('inst','validated/instructions');
  expect(nodeKnowledge('stories',[pack,newer,manifest,instructions],[{revision:manifest,content:{knowledge:[{revision:'old'}]}},{revision:instructions,content:{runScope:{knowledgeRefs:['old']}}}],true)).toEqual([{id:'old',sources:['direct','shared']}]);
 });
});

import {storyObservationGroups} from '../../src/components/workbench/storyObservationGroups';
describe('story evidence candidates',()=>{
 const observations=[{id:'one',featureId:'size'},{id:'two',featureId:'size'},{id:'other',featureId:'wallet'}];
 it('shows existing same-feature observations even when explicit links are empty',()=>{
  expect(storyObservationGroups(observations,['size'],[])).toEqual({linked:[],related:observations.slice(0,2)});
 });
 it('does not duplicate cited records or mix unrelated features',()=>{
  expect(storyObservationGroups(observations,['size'],['one'])).toEqual({linked:[observations[0]],related:[observations[1]]});
 });
});

import {nodeStatusKey} from '../../src/components/workbench/nodeStatus';
describe('shared node status labels',()=>{
 it('distinguishes queued startup from untouched nodes consistently',()=>{
  expect(nodeStatusKey()).toBe('workflow.status.queued');
  expect(nodeStatusKey('queued')).toBe('bench.nodeStarting');
  for(const phase of ['running','done','failed','blocked','waiting_review'])expect(nodeStatusKey(phase)).toBe('workflow.status.'+phase);
 });
});
