/** Isolated synthetic acceptance; never labels real run evidence as a human review. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
if(!process.env.TP_DATA_DIR?.startsWith('/tmp/')||!process.env.TP_UI_URL)throw new Error('Isolated /tmp TP_DATA_DIR and TP_UI_URL required');
const {createProject,db}=await import('../src/db.js');const svc=await import('../src/runService.js');
const {translate}=await import('../../src/lib/i18n.ts');
const project=createProject('Synthetic node comparison acceptance','https://fixture.test').id;
const runs=['A','B'].map(label=>{const r=svc.registerHostRun(project,{runtime:'codex',externalId:project+label,idempotencyKey:project+label,materials:[{name:'spec.md',text:'# Shared requirement\nAccount state must remain explicit.'}]});svc.runLedger().putRevision({runId:r.runId,projectId:project,name:'exploration.md',kind:'material',content:`# Synthetic ${label}\n${label==='A'?'Unknown state':'Observed empty list; business completion unverified'}`,mediaType:'text/markdown',sourceRefs:svc.runLedger().requireRun(r.runId,project).binding.materialRevisions},{kind:'system',id:'synthetic-ui-fixture'});return r.runId;});
const browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
const base=process.env.TP_UI_URL,out=resolve('/tmp/tp-node-comparison-ui-evidence');mkdirSync(out,{recursive:true});
try{
 for(const lang of ['zh','en','ja'] as const){
  const t=(key:string)=>translate('compare.'+key,lang);
  await page.goto(base);await page.evaluate(l=>localStorage.setItem('tp-lang',l),lang);
  await page.goto(base+'#/?'+new URLSearchParams({open:'evals',project}));await page.reload();
  await page.locator('summary').filter({hasText:t('title')}).click();
  await page.getByLabel(t('a'),{exact:true}).selectOption(runs[0]);await page.getByLabel(t('b'),{exact:true}).selectOption(runs[1]);
  await page.getByRole('button',{name:t('create'),exact:true}).click();
  await page.getByText('Synthetic A',{exact:true}).waitFor();await page.getByText('Synthetic B',{exact:true}).waitFor();
  await page.getByLabel(t('showInputs'),{exact:true}).check();await page.getByText('Shared requirement',{exact:true}).first().waitFor();
  await page.getByLabel(t('showInputs'),{exact:true}).uncheck();
  await page.getByLabel(t('reason'),{exact:true}).fill('Synthetic acceptance review only; this is not a real human evaluation.');
  await page.getByLabel(t('reviewGlobal'),{exact:true}).check();await page.getByLabel(/^spec.md/).first().check();await page.getByRole('button',{name:t('saveReview'),exact:true}).click();
  await page.getByText('Synthetic acceptance review only; this is not a real human evaluation.',{exact:true}).waitFor();
  await page.screenshot({path:resolve(out,lang+'.png'),fullPage:true});
  await page.reload();await page.locator('summary').filter({hasText:t('title')}).click();
  const history=page.getByLabel(t('history'),{exact:true});await history.locator('option').nth(1).waitFor({state:'attached'});await history.selectOption({index:1});
  await page.getByText('Synthetic acceptance review only; this is not a real human evaluation.',{exact:true}).waitFor();
 }
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile document overflow');
 await page.screenshot({path:resolve(out,'mobile.png'),fullPage:true});
 await page.getByRole('button',{name:translate('compare.saveReview','ja'),exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(out,'mobile-review.png'),fullPage:true});
 const other=createProject('Synthetic isolated comparison owner','https://other.test').id;await page.goto(base+'#/?'+new URLSearchParams({open:'evals',project:other}));await page.reload();await page.locator('summary').filter({hasText:translate('compare.title','ja')}).click();await page.getByLabel(translate('compare.history','ja'),{exact:true}).waitFor();assert.equal(await page.getByLabel(translate('compare.history','ja'),{exact:true}).locator('option').count(),1);
 assert.deepEqual(errors,[]);
 writeFileSync(resolve(out,'result.json'),JSON.stringify({synthetic:true,project,runs,languages:['zh','en','ja'],checks:['create','paired-output','paired-input','review','global-review','reload','mobile','project-isolation'],errors},null,2));
 console.log(JSON.stringify({passed:true,evidence:out,project}));
}catch(e){console.log((await page.locator('body').innerText()).slice(0,7000));await page.screenshot({path:resolve(out,'failure.png'),fullPage:true});throw e;}finally{await browser.close();svc.runLedger().close();db.close();}
