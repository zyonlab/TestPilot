import { readFileSync } from 'node:fs';
/** Export the exact reviewed implementations; never maintain a second verdict algorithm. */
export function exportOracleFiles(): Record<string,string> {
 const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
 const modelFiles=Object.fromEntries(['profiles','role-proxy','usage','flavor','connections-env'].map(name=>['tests/model/'+name+'.ts',read('../../packages/harness-core/src/model/'+name+'.ts')]));
 return {
  ...modelFiles,
  'tests/model/midscene.ts':read('../../packages/harness-testing/src/exec/model.ts').replaceAll('@testpilot/harness-core/model-profiles','./profiles.js'),
  'tests/oracle-core.ts':read('../../packages/harness-testing/src/exec/oracle.ts'),
  'tests/decimal.ts':read('../../packages/harness-testing/src/exec/decimal.ts'),
  'tests/interpolate.ts':read('../../packages/harness-core/src/util/interpolate.ts'),
  'tests/apiOracle.ts':read('../../packages/harness-testing/src/exec/apiOracle.ts').replaceAll('"@testpilot/harness-core"','"./interpolate.js"'),
  'tests/oracle.ts':`import type { Page } from '@playwright/test';
import { evaluateOracle, type MachineOracle, type PageSnapshot } from './oracle-core.js';
import { observeApi as observe } from './apiOracle.js';
export { readNumberNear } from './oracle-core.js';
export type Oracle = MachineOracle;
export const bodyText = (page: Page): Promise<string> => page.evaluate(() => document.body?.innerText ?? '');
export const observeApi = (o: Extract<Oracle,{kind:'api'}>, settle = true) => observe({...o,settleMs:settle?o.settleMs:0},{env:process.env as Record<string,string>,secrets:process.env as Record<string,string>});
export async function readBefore(page:Page, oracle:Oracle):Promise<PageSnapshot> {
 return {text:await bodyText(page),url:page.url(),...(oracle.kind==='api'?{api:await observeApi(oracle,false)}:{})};
}
export async function checkOracle(page:Page, oracle:Oracle, before?:PageSnapshot):Promise<void> {
 const after = {text:await bodyText(page),url:page.url(),...(oracle.kind==='api'?{api:await observeApi(oracle)}:{})};
 const verdict=evaluateOracle(oracle,after,before);
 if(verdict.status!=='pass') throw new Error('ORACLE_'+verdict.status.toUpperCase()+': '+verdict.detail);
}
`,
 };
}
