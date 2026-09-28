/** Runs production browser scope functions and the real collector against isolated state fixtures. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '@playwright/test';
import {readControlScopes,activateScopedControl} from '../../packages/harness-testing/src/exec/controlScope.js';
import {runObserve} from '../../packages/harness-testing/src/exec/interactive.js';
import {ExplorationCharterSchema} from '../../packages/harness-testing/src/domain/charter.js';
const html=`<html><head><title>Isolated state fixture</title></head><body>
<nav><button id="wrong" onclick="document.body.dataset.wrong='yes'">Market</button></nav>
<section><h2>Order form</h2><button>Buy / Long</button><button>Sell / Short</button><div id="market" style="cursor:pointer" onclick="this.dataset.state='selected';this.textContent='Market selected'">Market</div></section>
<section><div id="balances" style="cursor:pointer" onclick="this.setAttribute('aria-selected','true')">Balances <span>(1)</span></div></section>
<button id="mode" onclick="this.textContent='Account Type'">Manual</button>
<div role="dialog"><button id="dialog-market">Market</button></div>
</body></html>`;
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
const out=mkdtempSync(join(tmpdir(),'tp-explore-states-')),browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(url);
 const scopes=await page.evaluate(readControlScopes,['#wrong','#market','#dialog-market']);assert(!scopes[0].some(s=>s.includes('Buy / Long')));assert(scopes[1].some(s=>s.includes('Buy / Long')));assert(!scopes[2].some(s=>s.includes('Buy / Long')));
 const result=await page.evaluate(activateScopedControl,{sel:'#wrong',label:'Market',near:['Buy / Long','Sell / Short']});assert.equal(result,'relocated');assert.equal(await page.locator('body').getAttribute('data-wrong'),null);
 await page.goto(url);assert.equal(await page.evaluate(activateScopedControl,{sel:'#gone',label:'Market'}),'ambiguous:3');
 const charter=ExplorationCharterSchema.parse({schemaVersion:'exploration-charter.v1',id:'state-fixture',rulePack:{id:'fixture',version:'1',hash:'a'.repeat(64)},scope:{entryUrl:url},featureTargets:[
  {id:'market',featureId:'orders',match:{label:['^Market$'],near:['Buy / Long','Sell / Short']},action:'activate',sideEffect:'ui-only'},
  {id:'balances',featureId:'assets',match:{label:['^Balances$'],ignoreCountSuffix:true},action:'activate',sideEffect:'ui-only'},
  {id:'mode',featureId:'account',match:{label:['^(Manual|Unified)$']},action:'activate',sideEffect:'ui-only'},
 ],budgets:{maxScreens:8,maxRounds:12}});
 const observed=await runObserve({execId:'synthetic-state-fixture',url,artifactDir:out,charter,launch:{headless:true},deep:true,scenarioFirst:false,maxScreens:8,maxDurationMs:45000,settleMs:0,maxSettleMs:1500,explorationScope:'current-url'},()=>{});
 const report=observed.report!;assert(report.targets.some(t=>t.targetSpecId==='balances'&&t.label==='Balances (1)'),'actual collector must retain counted custom control');
 assert(report.targets.some(t=>t.targetSpecId==='mode'&&t.label==='Manual'));
 assert(report.targets.some(t=>t.targetSpecId==='balances'&&t.observedState?.includes('count=nonempty')));
 assert(report.targets.some(t=>t.targetSpecId==='market'&&t.scopeEvidence?.some(s=>s.includes('Buy / Long'))));
 assert(report.observations.some(o=>o.targetSpecId==='market'&&o.status==='attempted'),'scoped market interaction');
 assert.equal(report.assessment?.counts.assertionsPassed,null);
 writeFileSync(join(out,'result.json'),JSON.stringify({synthetic:true,scopedRelocation:result,report},null,2));console.log(JSON.stringify({passed:true,evidence:out,counts:report.assessment?.counts}));
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
