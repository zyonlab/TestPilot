/** Synthetic, isolated application UI acceptance. Start server with the same TP_DATA_DIR and web on TP_UI_URL. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from '@playwright/test';
if(!process.env.TP_DATA_DIR || !process.env.TP_UI_URL) throw new Error('Explicit isolated TP_DATA_DIR and TP_UI_URL required');
const {createProject,db}=await import('../src/db.js');
const svc=await import('../src/runService.js');
const {loadRunInstructions,retrieveRunSpec}=await import('../src/runStages.js');
const {evaluateExplorationResult}=await import('../src/explorationResults.js');
const {translate}=await import('../../src/lib/i18n.ts');
const out=resolve(process.env.TP_UI_EVIDENCE_DIR??resolve(tmpdir(),'tp-integrated-ui-evidence'));mkdirSync(out,{recursive:true});
const project=createProject('Synthetic integrated UI acceptance','http://127.0.0.1:5301/testdapp').id;
const registered=svc.registerHostRun(project,{runtime:'codex',externalId:project,idempotencyKey:project,materials:[{name:'spec.md',text:'# Login\nUse password.\n# Oversized\n'+'big '.repeat(600)}]});
const run=registered.runId;
await loadRunInstructions(run,project);
for(let n=0;n<10;n++)await retrieveRunSpec(run,project,{query:'Login',budgetTokens:200,chunkIds:['materials/spec.md#1','materials/spec.md#2','unknown'],node:'cases'});
const revisions:Record<string,string>={};
function put(name:string,content:unknown){revisions[name]=svc.runLedger().putRevision({runId:run,projectId:project,name,kind:'report',content,mediaType:'application/json',sourceRefs:[]},{kind:'system',id:'synthetic-ui-fixture'}).id;}
put('integration/receipt',{status:'failed',logs:[],observation:{version:1,stages:[{stage:'preparation',durationMs:1500,status:'failed',model:{source:'unavailable',forwarded:null,blocked:null},failure:{attribution:'infra',retryable:false}}],cache:{session:'unavailable',midscene:'unknown'},retries:[]},lifecycle:{version:1,status:'unknown',checks:[],cleanup:[{id:'clean',postStep:1,status:'not-run',detail:'Session closed'}],pendingResources:[{id:'r1',identity:'synthetic-owned-123',reason:'Cancelled'}],safeToRetry:false},evidenceReuse:{context:{version:1,digest:'synthetic-digest',hints:[{}],sourceRevision:'synthetic-source',rejected:[]},events:[{status:'used',reason:'current_ui_validated',label:'Open',source:{revision:'synthetic-source',observation:'synthetic-observation',edge:'sfg:edge:0',state:'entry'}},{status:'fallback',reason:'hidden'}]}});
put('integration/legacy',{status:'failed',logs:[]});
put('integration/malformed',{schemaVersion:'retrieval-audit.v1',delivery:{chunks:null}});
put('integration/exploration',evaluateExplorationResult({url:'http://127.0.0.1/',graph:{entry:'entry',states:[{id:'entry',route:'/',controls:['button: Open']}],transitions:[],unvisited:['/unvisited']},stopped:{kind:'dry'}}));
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`)});
const results:string[]=[];
const base=process.env.TP_UI_URL;
const href=(extra:Record<string,string>={})=>base+'/#/?'+new URLSearchParams({open:'canvas',project,run,...extra});
async function contains(text:string){await page.getByText(text,{exact:false}).first().waitFor({state:'visible',timeout:15000});}
try{
for(const lang of ['zh','en','ja'] as const){
 const t=(k:string)=>translate(k,lang);
 await page.goto(base);await page.evaluate(l=>localStorage.setItem('tp-lang',l),lang);
 await page.goto(href({node:'cases'}));await page.reload();
 const summary=page.locator('summary').filter({hasText:t('retrieval.runHistory')});await summary.click();
 await contains(t('retrieval.moreRecords'));await page.getByRole('button',{name:t('retrieval.moreRecords')}).click();
 assert.equal(await page.getByRole('button',{name:t('retrieval.moreRecords')}).count(),0);
 // Open a real audit from its actual history entry, not a component harness.
 await page.getByRole('button',{name:new RegExp(t('retrieval.title'))}).first().click();
 await page.locator('summary').filter({hasText:'materials/spec.md#1'}).click();
 await contains('Use password.');await contains(t('retrieval.boundary'));await contains(t('retrieval.unknownRequiredIds'));
 await page.screenshot({path:resolve(out,`${lang}-retrieval.png`),fullPage:true});
 for(const [name,id] of Object.entries(revisions)){
  await page.goto(href({artifact:id}));await contains(t('workflow.download'));
  if(name.endsWith('receipt')){await contains('synthetic-owned-123');await contains('synthetic-observation');await contains(t('observation.stage.preparation'));await contains(t('reuse.reason.hidden'));}
  if(name.endsWith('legacy'))await contains(t('observation.missing'));
  if(name.endsWith('malformed'))await contains(t('retrieval.unknown'));
  if(name.endsWith('exploration'))await contains(t('exploration.evidence.scope_undeclared'));
  await page.screenshot({path:resolve(out,`${lang}-${name.split('/')[1]}.png`),fullPage:true});
  results.push(`${lang}: ${name}`);
 }
 await page.goto(href());await page.getByRole('button',{name:t('workflow.new'),exact:true}).click();
 const field=page.getByLabel(t('reuse.pageVersion'),{exact:false});await field.fill('synthetic-v1');assert.equal(await field.inputValue(),'synthetic-v1');await contains(t('reuse.versionHelp'));
 await page.getByRole('button',{name:t('bench.source.spec'),exact:true}).click();await page.getByRole('textbox',{name:t('workflow.requirements'),exact:true}).fill('# Synthetic requirements');
 await page.screenshot({path:resolve(out,`${lang}-new-run.png`),fullPage:true});results.push(`${lang}: history pagination, audit, new run source switching`);
 await page.getByRole('button',{name:t('bench.close'),exact:true}).click();
}
await page.setViewportSize({width:390,height:844});await page.goto(href({artifact:revisions['integration/receipt']}));await contains('synthetic-owned-123');
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal document overflow');
const bounds=await page.getByRole('dialog').last().boundingBox();assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=391,'drawer clipped by viewport');
await page.screenshot({path:resolve(out,'mobile-receipt.png'),fullPage:true});results.push('390px receipt');
await page.setViewportSize({width:1440,height:1000});
await page.goto(href({artifact:revisions['integration/receipt']}));await page.evaluate(()=>localStorage.setItem('tp-theme','dark'));await page.reload();await contains('synthetic-owned-123');
await page.screenshot({path:resolve(out,'dark-receipt.png'),fullPage:true});results.push('dark receipt');
for(const surface of ['review','artifacts','runs','baselines','evals','settings']){
 await page.goto(href({open:surface}));await page.waitForLoadState('networkidle');
 assert((await page.locator('body').innerText()).includes('Synthetic integrated UI acceptance'),surface+' project context');
 await page.screenshot({path:resolve(out,`surface-${surface}.png`),fullPage:true});results.push(`navigation: ${surface}`);
}
assert.deepEqual(errors,[],'browser console/network errors');
writeFileSync(resolve(out,'results.json'),JSON.stringify({project,run,results,errors,screenshots:out},null,2));console.log(JSON.stringify({checks:results.length,errors,evidence:out}));
}catch(error){await page.screenshot({path:resolve(out,'failure.png'),fullPage:true});throw error;}finally{await browser.close();svc.runLedger().close();db.close();}
