import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {askForScenarios,type ObserveSpec} from '../src/exec/interactive.js';
import {validateRulePack,charterFromRulePack,CharterTracker} from '../src/domain/index.js';
const screen={url:'https://fixture.test/trade',title:'Trade',text:'Limit order requires a price',elements:[{label:'Limit',group:'orders',selectedNow:false,role:'',container:'Order form'},{label:'Place Order',group:'orders',selectedNow:false}]};
it('host receives component evidence and charter, rejects invented control IDs, and keeps risk distinct from facts',async()=>{
 const ask=vi.fn(async(_req:{prompt:string})=>JSON.stringify({business:'交易',stories:[],decisions:[{control:0,feature:'限价',reason:'Limit 标签',expected:'价格字段',risk:'ui-only'},{control:1,feature:'下单',reason:'提交',expected:'订单',risk:'state-change'},{control:99,feature:'虚构',risk:'ui-only'}]}));
 const plan=await askForScenarios({ask,charter:{id:'frozen'}} as unknown as ObserveSpec,screen,()=>{});
 expect(ask.mock.calls[0][0].prompt).toContain('Order form');expect(ask.mock.calls[0][0].prompt).toContain('frozen');
 expect(plan?.decisions?.map(d=>d.control)).toEqual([0,1]);expect(plan?.decisions?.[1].risk).toBe('state-change');
});
it('invalid model data cannot authorize a component',async()=>{
 const note=vi.fn();
 expect(await askForScenarios({ask:async()=>'{bad'} as unknown as ObserveSpec,screen,note)).toBeUndefined();
 expect(await askForScenarios({ask:async()=>JSON.stringify({business:'x',stories:[],decisions:[{control:0,risk:'safe'}]})} as unknown as ObserveSpec,screen,note)).toBeUndefined();
});
it('builtin enables UI activation while blocking order submission and confirmation',()=>{
 const parsed=validateRulePack(JSON.parse(readFileSync(new URL('../../../examples/hyperliquid-testnet/rule-pack.json',import.meta.url),'utf8')));
 expect(parsed.ok,JSON.stringify(parsed)).toBe(true);if(!parsed.ok)return;
 const charter=charterFromRulePack(parsed.pack,parsed.hash,{entryUrl:'https://app.hyperliquid-testnet.xyz/trade',maxScreens:8});
 expect(parsed.pack.targets.every(t=>t.action==='activate' && t.sideEffect==='ui-only')).toBe(true);
 for(const label of ['Place Order','Confirm','Cancel All'])expect(charter.actionsPolicy.forbidLabels.some(re=>new RegExp(re,'i').test(label))).toBe(true);
 expect(charter.featureTargets.find(t=>t.id==='T-market')?.match.near).toEqual(['Buy / Long','Sell / Short']);
});

it('accepts a reply that is exactly one fenced JSON block, but not JSON buried in prose',async()=>{
 const body=JSON.stringify({business:'交易',stories:[],decisions:[{control:0,feature:'限价',reason:'Limit 标签',expected:'价格字段',risk:'ui-only'}]});
 const fenced=await askForScenarios({ask:async()=>'```json\n'+body+'\n```'} as unknown as ObserveSpec,screen,()=>{});
 expect(fenced?.decisions?.map(d=>d.control)).toEqual([0]);
 expect(await askForScenarios({ask:async()=>'Here you go:\n```json\n'+body+'\n```'} as unknown as ObserveSpec,screen,()=>{})).toBeUndefined();
});

it('lists rule-pack targets that were seen but not tried, until they are tried',()=>{
 const parsed=validateRulePack(JSON.parse(readFileSync(new URL('../../../examples/hyperliquid-testnet/rule-pack.json',import.meta.url),'utf8')));
 if(!parsed.ok)throw new Error('pack');
 const charter=charterFromRulePack(parsed.pack,parsed.hash,{entryUrl:'https://app.hyperliquid-testnet.xyz/trade',maxScreens:8});
 const tracker=new CharterTracker(charter);
 const spec=charter.featureTargets.find(t=>t.sideEffect==='ui-only'&&t.action==='activate'&&t.match.label.length)!;
 const label=spec.match.label[0]!.replace(/^\^|\$$/g,'');
 const found=tracker.noteState('s1','/trade',[{label,display:label,selector:'#t',role:'tab',group:'',state:'',clickable:true,within:spec.match.within??[],near:spec.match.near??[]} as never],0);
 const pending=tracker.pendingSeenTargets();
 expect(found.length).toBeGreaterThan(0);
 expect(pending.map(t=>t.targetSpecId)).toContain(spec.id);expect(tracker.specCovered(spec.id)).toBe(false);
 tracker.record({targetId:pending[0]!.stableId,targetSpecId:spec.id,featureId:spec.featureId,status:'attempted',stateBefore:'s1',evidenceRefs:[],round:1} as never);expect(tracker.specCovered(spec.id)).toBe(true);
 tracker.markAttempted(pending[0]!.stableId);expect(tracker.pendingSeenTargets().some(t=>t.stableId===pending[0]!.stableId)).toBe(false);
});
