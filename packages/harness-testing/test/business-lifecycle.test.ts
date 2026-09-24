import {createHash} from 'node:crypto';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateRulePack,rulePackHash} from '../src/domain/rules.js';
const example=JSON.parse(readFileSync(new URL('../../../examples/hyperliquid-testnet/rule-pack.json',import.meta.url),'utf8'));
describe('business lifecycle input',()=>{
 it('keeps pending orders distinct from positions and every transition hypothetical',()=>{
  const result=validateRulePack(example);expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.pack.businessTransitions).toHaveLength(9);
  expect(result.pack.businessTransitions.every(t=>t.claimType==='hypothesis')).toBe(true);
  expect(result.pack.businessTransitions.find(t=>t.id==='margin.add')?.preconditions.join()).toContain('已有持仓');
 });
 it('accepts legacy packs and rejects broken transition provenance',()=>{
  const legacy={...example};delete legacy.businessTransitions;
  const old=validateRulePack(legacy);expect(old.ok&&old.pack.businessTransitions).toEqual([]);
  if(old.ok){const before={...old.pack};delete (before as Partial<typeof before>).businessTransitions;expect(old.hash).toBe(createHash("sha256").update(canonicalJSON(before)).digest("hex"));expect(rulePackHash(old.pack)).toBe(old.hash);}
  const broken=structuredClone(example);broken.businessTransitions[0].featureId='missing';broken.businessTransitions[0].sourceRefs=['missing'];
  const result=validateRulePack(broken);expect(result.ok).toBe(false);if(!result.ok)expect(result.errors.filter(e=>e.code==='dangling_ref')).toHaveLength(2);
 });
});
