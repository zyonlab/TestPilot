import { expect, it } from 'vitest';
import { executionBlockers } from '../src/casegen/readiness.js';
import { checkDesignEvidence } from '../src/casegen/designEvidence.js';
import type { TextCase } from '../src/casegen/types.js';
import { verifySessionChecks, type SessionCheck } from '../src/domain/sessionEvidence.js';
const base = {id:'C',expected:'Mark',steps:['Open page'],readiness:{design:'candidate',execution:'ready'},oracle:{kind:'text',value:'Mark'}} as TextCase;
it('allows a static check without inventing financial fixture requirements',()=>expect(executionBlockers(base)).toEqual([]));
it('blocks contradictory ready declarations in design validation',()=>{
 const c={...base,readiness:{...base.readiness!,reason:'缺已验证账户及资金夹具'}};
 expect(checkDesignEvidence([c]).some(e=>e.code==='ready_without_evidence')).toBe(true);
});
it('requires an oracle for each independent assertion',()=>{
 const c={...base,assertions:[{id:'mark',statement:'Mark',ruleRefs:[]},{id:'oracle',statement:'Oracle',ruleRefs:[]}]};
 expect(executionBlockers(c)).toEqual(['missing_machine_oracle:oracle']);
});
it('does not mistake unresolved requirements or missing readiness for admission',()=>{
 expect(executionBlockers({...base,readiness:undefined})).toContain('readiness:not-assessed');
 expect(executionBlockers({...base,readiness:{...base.readiness!,requirements:[{id:'cash',kind:'fixture',status:'verified',evidenceRefs:[]}]}})).toContain('unverified_requirement:fixture:cash');
});
it('does not treat prose/none as an executable oracle',()=>expect(executionBlockers({...base,oracle:{kind:'none'}})).toContain('missing_machine_oracle:expected'));
const check: SessionCheck={capability:'wallet-session',checks:[{kind:'connected',label:'Connected'},{kind:'address',label:'0x1234567890'},{kind:'network',label:'Testnet'}]};
it('requires visible connection, full identity and network together',()=>{
 expect(verifySessionChecks([check],['Connected','0x1234567890','Testnet'])[0].verified).toBe(true);
 expect(verifySessionChecks([check],['Connected','0x1234567890'])[0].verified).toBe(false);
 expect(verifySessionChecks([{...check,checks:check.checks.map(c=>c.kind==='address'?{...c,label:'0x12…90'}:c)}],['Connected','0x12…90','Testnet'])[0].verified).toBe(false);
 expect(verifySessionChecks([{capability:'wallet-session',checks:[]}],[])[0].verified).toBe(false);
});
it('cannot certify a decimal formula using a visible label or model judgment',()=>{
 expect(executionBlockers({...base,expected:'显示区间包含Q×P'})).toContain('missing_numeric_calculation:expected');
});
it('preserves structured story evidence and rejects invalid states',async()=>{
 const {StorySchema}=await import('../src/casegen/types.js');
 const story={id:'S',title:'Title',acceptance:['Given / When / Then'],observationLinks:[{acceptanceIndex:0,status:'unobserved',reason:'not_attempted',observationIds:[],nextSteps:['Open the panel']} ]};
 expect(StorySchema.parse(story).observationLinks).toEqual(story.observationLinks);
 expect(StorySchema.safeParse({...story,observationLinks:[{...story.observationLinks[0],acceptanceIndex:-1}]}).success).toBe(false);
});

it('does not classify slash-separated trading labels as arithmetic',()=>{
 for(const value of ['Buy / Long','Sell / Short']) expect(executionBlockers({...base,expected:value,oracle:{kind:'text',value}})).toEqual([]);
 expect(executionBlockers({...base,expected:'Q / P'})).toContain('missing_numeric_calculation:expected');
});
