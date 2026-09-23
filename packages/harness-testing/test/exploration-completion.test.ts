import {describe,it,expect} from 'vitest';
import {assessExploration,buildExplorationReport,ExplorationCharterSchema,InteractionTargetSchema,ObservationSchema} from '../src/domain/index.js';
import {StateFlowGraphSchema,abstractionOf} from '../src/exec/sfg.js';
const charter=ExplorationCharterSchema.parse({schemaVersion:'exploration-charter.v1',id:'scope',rulePack:{id:'rules',version:'1',hash:'a'.repeat(64)},scope:{entryUrl:'https://example.test/',routes:['/'],urlPatterns:[]},featureTargets:[{id:'open',featureId:'panel',match:{label:['Open']},action:'activate',sideEffect:'ui-only'}],budgets:{maxScreens:8}});
const action={kind:'click' as const,target:'Open',selector:'#open'};
const graph=StateFlowGraphSchema.parse({entry:'s1',states:[{id:'s1',route:'/',controls:['Open']},{id:'s2',route:'/',controls:['Close']}],transitions:[{from:'s1',to:'s2',action,ok:true,walked:true}]});
const target=InteractionTargetSchema.parse({stableId:'control',targetSpecId:'open',featureId:'panel',stateId:'s1',route:'/',label:'Open',display:'Open',selector:'#open',foundAtRound:0});
const observation=ObservationSchema.parse({id:'obs1',targetId:'control',targetSpecId:'open',featureId:'panel',stateBefore:'s1',stateAfter:'s2',action,status:'attempted',evidenceRefs:['sfg:edge:0','sfg:state:s2'],round:1});
const base=()=>({entryUrl:charter.scope.entryUrl,charter:structuredClone(charter),graph:structuredClone(graph),targets:[structuredClone(target)],observations:[structuredClone(observation)],stop:{kind:'dry'}});

describe('bounded exploration completion',()=>{
 it('requires an actual matching transition and post-state; it never claims business assertion success',()=>{
  const r=assessExploration(base());expect(r.status).toBe('complete');expect(r.counts).toEqual({seen:1,attempted:1,interactionCompleted:1,observationCompleted:0,assertionsPassed:null});expect(r.scope.denominator).toBe(1);
 });
 it.each(['unknown','Offline','blocked','timeBudget','screenCap','actionBudget','cancelled','stuck','entryOnly','future-stop'])('%s never completes even with all targets satisfied',kind=>{
  expect(assessExploration({...base(),stop:{kind}}).status).toBe('partial');
 });
 it('a mislabeled dry stop cannot override an exhausted measured budget',()=>{
  expect(assessExploration({...base(),budget:{maxScreens:2,screens:2,maxRounds:10,rounds:1}})).toMatchObject({status:'partial',reasons:['budget_exhausted']});
 });
 it('empty declared scope and ordinary exploration cannot invent a denominator or coverage',()=>{
  const input=base();input.charter.featureTargets=[];expect(assessExploration(input)).toMatchObject({status:'unknown',scope:{denominator:0}});
  expect(assessExploration({...input,charter:undefined})).toMatchObject({status:'unknown',scope:{denominator:null}});
 });
 it.each(['failed','skipped_equivalent','blocked'] as const)('%s alone remains a frontier gap',status=>{
  const input=base();input.observations[0].status=status;
  const r=buildExplorationReport({...input,budget:{maxScreens:8,screens:2,rounds:1,maxRounds:10}});
  expect(r.completion).toBe('partial');expect(r.frontier.map(t=>t.targetSpecId)).toEqual(['open']);
 });
 it('a real failed dispatch counts as tried, never as completed',()=>{
  const input=base();input.graph.transitions[0].ok=false;delete input.graph.transitions[0].to;input.observations[0].status='failed';delete input.observations[0].stateAfter;
  expect(assessExploration(input).counts).toMatchObject({attempted:1,interactionCompleted:0});
 });
 it.each(['no-after','fake-after','wrong-edge','unwalked','wrong-action','failed-edge','bad-ref','bad-target','no-refs'])('rejects %s despite a success claim',fault=>{
  const input=base(),o=input.observations[0],e=input.graph.transitions[0];
  if(fault==='no-after')delete o.stateAfter;
  if(fault==='fake-after')o.stateAfter='fake';
  if(fault==='wrong-edge')e.from='s2';
  if(fault==='unwalked')e.walked=false;
  if(fault==='wrong-action')e.action.target='Delete';
  if(fault==='failed-edge')e.ok=false;
  if(fault==='bad-ref')o.evidenceRefs.push('sfg:edge:999');
  if(fault==='bad-target')o.targetId='other-control';
  if(fault==='no-refs')o.evidenceRefs=[];
  expect(assessExploration(input).status).toBe('partial');expect(assessExploration(input).counts.interactionCompleted).toBe(0);
 });
 it('observe-only requires a visible state receipt, but not a click',()=>{
  const input=base();input.charter.featureTargets[0].action='observe-only';input.graph.transitions=[];
  input.observations[0]={...observation,status:'observed_only',stateAfter:undefined,evidenceRefs:['sfg:state:s1']};
  expect(assessExploration(input)).toMatchObject({status:'complete',counts:{attempted:0,observationCompleted:1,interactionCompleted:0}});
  input.observations[0].evidenceRefs=['sfg:state:missing'];expect(assessExploration(input).status).toBe('partial');
 });

 it('arbitrary existing states do not prove an observe-only control was visible',()=>{
  const input=base();input.charter.featureTargets[0].action='observe-only';input.observations[0]={...observation,status:'observed_only',stateBefore:'s2',stateAfter:undefined,evidenceRefs:['sfg:state:s2']};
  expect(assessExploration(input).status).toBe('partial');
  input.targets[0].display='Invented';expect(assessExploration(input).counts.seen).toBe(0);
 });
 it('repeated failed actions are visible without counting a successful transition',()=>{
  const input=base();input.graph.transitions=Array.from({length:4},()=>({...graph.transitions[0],ok:false,to:undefined}));
  expect(assessExploration(input).progress).toMatchObject({uniqueWalkedTransitions:0,repeatedActions:3});
 });
 it('a deterministic path reports distinct states and transitions without requiring repetition',()=>{
  const input=base();for(let i=2;i<6;i++){input.graph.states.push({id:`s${i+1}`,route:`/${i}`,title:'',controls:[]});input.graph.transitions.push({from:`s${i}`,to:`s${i+1}`,action,walked:true,ok:true});}
  expect(assessExploration(input).progress).toMatchObject({abstractStates:6,uniqueWalkedTransitions:5,repeatedActions:0});
 });
 it('high-changing numeric controls use the existing abstraction and repeated transitions add no progress',()=>{
  const signature=abstractionOf('route+controls+state/norm');
  expect(new Set(Array.from({length:100},(_,i)=>signature({url:'https://example.test/',controls:[],states:[`Price ${i}.25`,`Time 10:20:${i}`]}))).size).toBe(1);
  const input=base();for(let i=0;i<100;i++)input.graph.transitions.push({...graph.transitions[0],action:{...action,target:`Open ${i}`}});
  // One original label and one normalized numbered label.
  expect(assessExploration(input).progress).toMatchObject({abstractStates:2,uniqueWalkedTransitions:2,repeatedActions:99});
 });
});
