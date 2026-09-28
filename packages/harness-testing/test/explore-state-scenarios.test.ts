import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {ExplorationTargetSpecSchema} from '../src/domain/rules.js';
import {matchTarget,type ControlLike,ExplorationCharterSchema,activationBlocker} from '../src/domain/charter.js';
import {buildExplorationReport} from '../src/domain/report.js';
import {validateRulePack} from '../src/domain/rules.js';
import {StateFlowGraphSchema,abstractionOf} from '../src/exec/sfg.js';
const control=(label:string,scopes:string[]=[]):ControlLike=>({display:`div: ${label}`,label,selector:'#control',role:'',href:'',external:false,submit:false,clickable:true,fillable:false,state:'',scopes});
const target=ExplorationTargetSpecSchema.parse({id:'list',featureId:'assets',match:{label:['^Balances$'],ignoreCountSuffix:true},action:'activate',sideEffect:'ui-only'});
it.each(['Balances','Balances (0)','Balances (1)','Balances (23)'])('matches opted-in counter label %s while preserving original evidence',label=>{const c=control(label);expect(matchTarget(c,target,'/')).toBe(true);expect(c.label).toBe(label);});
it('does not erase business quantities, unrelated suffixes, or assume normalization for old rules',()=>{
 expect(matchTarget(control('Balances (1)'),{...target,match:{...target.match,ignoreCountSuffix:undefined}},'/')).toBe(false);
 for(const label of ['Balances (pending)','Balances 23','Balances (1) disabled'])expect(matchTarget(control(label),target,'/')).toBe(false);
 const abstract=abstractionOf('route+controls+state/norm');expect(abstract({url:'https://fixture.test',controls:['Balances (0)'],states:['Balances (0)#count=empty']})).not.toBe(abstract({url:'https://fixture.test',controls:['Balances (1)'],states:['Balances (1)#count=nonempty']}));
});
it('requires all regional anchors in one scope, never joins separate regions',()=>{
 const t={...target,match:{...target.match,label:['^Market$'],near:['Buy / Long','Sell / Short']}};
 expect(matchTarget(control('Market',['Buy / Long Market Sell / Short']),t,'/')).toBe(true);
 expect(matchTarget(control('Market',['Buy / Long','Sell / Short']),t,'/')).toBe(false);
 expect(matchTarget(control('Market'),t,'/')).toBe(false);
});
it('rebuilding a report does not multiply gaps or remove uncovered targets',()=>{
 const charter=ExplorationCharterSchema.parse({schemaVersion:'exploration-charter.v1',id:'fixture',rulePack:{id:'rules',version:'1',hash:'a'.repeat(64)},scope:{entryUrl:'https://fixture.test'},featureTargets:[target],budgets:{maxScreens:4}});
 const input={charter,graph:StateFlowGraphSchema.parse({entry:'s',states:[{id:'s',route:'/',controls:[]}],transitions:[]}),targets:[],observations:[],stop:{kind:'dry'},budget:{maxScreens:4,screens:1,rounds:1,maxRounds:10}};
 const a=buildExplorationReport(input),b=buildExplorationReport({...input,unknowns:a.unknowns});expect(b.unknowns).toEqual(a.unknowns);expect(b.assessment?.scope.denominator).toBe(1);expect(b.completion).toBe('partial');
});
it('updated trading rule pack validates and recognizes both observed account-mode labels without authorizing trades',()=>{
 const v=validateRulePack(JSON.parse(readFileSync(new URL('./fixtures/hyperliquid-testnet-rules-2026-09-20.json',import.meta.url),'utf8')));expect(v.ok,v.ok?'':JSON.stringify(v.errors)).toBe(true);if(!v.ok)return;
 const mode=v.pack.targets.find(t=>t.id==='T-account-mode')!;
 for(const label of ['Manual','Unified'])expect(matchTarget(control(label),mode,'/trade')).toBe(true);
 expect(v.pack.targets.every(t=>t.sideEffect!=='state-change')).toBe(true);
 const trade=ExplorationTargetSpecSchema.parse({...target,sideEffect:'state-change'});
 expect(activationBlocker(control(trade.match.label[0]),trade,{allow:['activate-ui'],allowStateChange:false,neverSubmit:true,forbidLabels:[]},new Set())).toBe('policy:side_effect');
});
