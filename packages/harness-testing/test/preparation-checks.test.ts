import {it,expect,vi} from 'vitest';
import {checkPrerequisite,PrerequisiteCheckSchema} from '../src/exec/preparationChecks.js';
const check=PrerequisiteCheckSchema.parse({statement:'Runtime configured and page ready',checks:[{kind:'environment',fact:'injected-wallet',expected:true},{kind:'environment',fact:'injected-chain',expected:123},{kind:'screen',statement:'Ready',oracle:{kind:'text',value:'Ready'}}]});
const input=()=>({facts:[{fact:'injected-wallet' as const,value:true,source:'runner:provider-installation',capturedAt:1},{fact:'injected-chain' as const,value:123,source:'runner:provider-installation',capturedAt:1}],snapshot:async()=>({text:'Ready',url:'https://example.test',capturedAt:Date.now()}),assert:vi.fn(),resolve:(s:string)=>s,redact:(s:string)=>s.replaceAll('top-secret','[redacted]')});
it('requires every environment and screen component; installation cannot satisfy an authentication check',async()=>{
 const base=input();expect((await checkPrerequisite(check,base)).status).toBe('pass');expect(base.assert).not.toHaveBeenCalled();
 expect((await checkPrerequisite({...check,checks:[...check.checks,{kind:'environment',fact:'authentication',expected:true}]},base)).status).toBe('unknown');
 expect((await checkPrerequisite(check,{...base,facts:base.facts.map(f=>({...f,value:false}))})).status).toBe('fail');
});
it('preserves the statement and returns an explicit unknown for an empty model assertion diagnostic',async()=>{
 const base=input();base.assert.mockRejectedValue(new Error('Assertion failed: undefined'));
 const out=await checkPrerequisite({statement:'Approved condition',checks:[{kind:'screen',statement:'Visible field'}]},base);
 expect(out).toMatchObject({statement:'Approved condition',status:'unknown'});expect(out.detail).toContain('Visible field');
});
it('redacts diagnostic and source values without changing the check performed',async()=>{
 const base=input();base.assert.mockRejectedValue(new Error('top-secret unavailable'));
 const out=await checkPrerequisite({statement:'Approved condition',checks:[{kind:'screen',statement:'Read ${secret.token}'}]},{...base,resolve:()=> 'top-secret'});
 expect(base.assert).toHaveBeenCalledWith('top-secret');expect(JSON.stringify(out)).not.toContain('top-secret');
});
it('rejects off-screen or historical oracles and unknown environment keys',()=>{
 expect(()=>PrerequisiteCheckSchema.parse({statement:'Balance',checks:[{kind:'screen',statement:'Balance',oracle:{kind:'delta',value:'Balance',direction:'unchanged'}}]})).toThrow();
 expect(()=>PrerequisiteCheckSchema.parse({statement:'Environment',checks:[{kind:'environment',fact:'funded',expected:true}]})).toThrow();
});
it('recomputes a decimal equation using a new same-screen snapshot on every check',async()=>{
 const numeric=PrerequisiteCheckSchema.parse({statement:'Panel total equals inputs',checks:[{kind:'screen',statement:'Total',oracle:{kind:'decimal-equation',scope:{start:'Panel',end:'End'},inputs:[{id:'a',label:'Available',unit:'USD',decimals:2,rounding:'exact'},{id:'b',label:'Held',unit:'USD',decimals:2,rounding:'exact'},{id:'total',label:'Total',unit:'USD',decimals:2,rounding:'exact'}],actual:'total',formula:['a','b','+'],maxAgeMs:1000}}]});
 const base=input(),text='Panel\nAvailable: 2.00 USD\nHeld: 3.00 USD\nTotal: 5.00 USD\nEnd';
 expect((await checkPrerequisite(numeric,{...base,snapshot:async()=>({text,url:'https://example.test',capturedAt:Date.now()})})).status).toBe('pass');
 expect((await checkPrerequisite(numeric,{...base,snapshot:async()=>({text,url:'https://example.test',capturedAt:Date.now()-10001})})).status).toBe('unknown');
 expect((await checkPrerequisite(numeric,{...base,snapshot:async()=>({text:text.replace('5.00','6.00'),url:'https://example.test',capturedAt:Date.now()})})).status).toBe('fail');
});
