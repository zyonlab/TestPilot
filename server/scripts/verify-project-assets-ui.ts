/** Read-only UI smoke against an existing project. Never imports or adopts real assets. */
import {chromium,expect} from '@playwright/test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const [project,run]=process.argv.slice(2);if(!project||!run)throw new Error('usage: verify-project-assets-ui.ts PROJECT RUN');
const response=await fetch(`http://localhost:5301/api/projects/${encodeURIComponent(project)}/workflow-runs/${encodeURIComponent(run)}`);if(!response.ok)throw new Error('run_missing');
const data=await response.json() as {revisions:Array<{id:string;kind:string;name:string}>};const source=data.revisions.find(r=>r.kind==='material');if(!source)throw new Error('material_required');
const dir=mkdtempSync(join(tmpdir(),'tp-project-assets-ui-')),browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://localhost:5300/#/?open=artifacts&project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&artifact=${encodeURIComponent(source.id)}`);
 await expect(page.getByRole('heading',{name:'项目资产版本',exact:true})).toBeVisible({timeout:20000});
 await expect(page.getByRole('button',{name:'登记为候选版本',exact:true})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'稳定资产名称（同一资产沿用此名称）',exact:true})).toHaveValue(source.name);
 await expect(page.getByText('快照用于保存与比较项目资产版本，不会启动运行、改变现有运行输入或保存账户当前状态。',{exact:true})).toBeVisible();
 if(errors.length)throw new Error(errors.join('\n'));
 await page.screenshot({path:join(dir,'materials-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'项目资产版本',exact:true})).toBeVisible();
 await page.screenshot({path:join(dir,'materials-mobile.png'),fullPage:true});
 writeFileSync(join(dir,'result.json'),JSON.stringify({passed:true,readOnly:true,source:source.id,errors},null,2));console.log(JSON.stringify({passed:true,evidence:dir}));
}finally{await browser.close();}
