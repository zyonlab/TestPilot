#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const suites={
 source:{cwd:'packages/harness-testing',files:['test/explore-state-scenarios.test.ts','test/exploration-completion.test.ts']},
 modules:{cwd:'server',files:['test/module-stage.test.ts']},
 stories:{cwd:'packages/harness-testing',files:['test/storyQuality.test.ts']},
 cases:{cwd:'packages/harness-testing',files:['test/casegen.test.ts']},
 gate:{cwd:'packages/harness-testing',files:['test/gate-evidence-severity.test.ts']},
 finalize:{cwd:'server',files:['test/registered-eval.test.ts','test/artifact-comparisons.test.ts']},
 g2:{cwd:'server',files:['test/preparation.test.ts','test/preparation-experience.test.ts']},
 execution:{cwd:'packages/harness-testing',files:['test/lifecycle-run.test.ts']},
};
const args=process.argv.slice(2),node=args[0]==='--node'?args[1]:'all';
if(!node||(node!=='all'&&!Object.hasOwn(suites,node))||args.length>2){console.error('Usage: pnpm eval:node-quality --node all|source|modules|stories|cases|gate|finalize|g2|execution');process.exit(2);}
const selected=node==='all'?Object.entries(suites):[[node,suites[node]]];
const sha=b=>createHash('sha256').update(b).digest('hex');
const out=mkdtempSync(join(tmpdir(),'tp-node-quality-'));mkdirSync(out,{recursive:true});
const report={schemaVersion:'node-quality-regression.v1',kind:'development-regression',independentHoldout:false,at:new Date().toISOString(),evaluatorHash:sha(readFileSync(fileURLToPath(import.meta.url))),suites:selected.map(([name,s])=>({node:name,...s,hashes:s.files.map(f=>({path:join(s.cwd,f),hash:sha(readFileSync(resolve(root,s.cwd,f)))}))})),results:[]};
writeFileSync(join(out,'preregistered.json'),JSON.stringify(report,null,2));
// Batch tests sharing a package. No retries; every original log remains available.
for(const cwd of [...new Set(selected.map(([,s])=>s.cwd))]){
 const files=[...new Set(selected.filter(([,s])=>s.cwd===cwd).flatMap(([,s])=>s.files))];
 const start=Date.now(),result=spawnSync('pnpm',['exec','vitest','run',...files],{cwd:resolve(root,cwd),encoding:'utf8',maxBuffer:16_000_000,timeout:300_000});
 const log=cwd.replaceAll('/','-')+'.log';writeFileSync(join(out,log),(result.stdout??'')+(result.stderr??''));
 report.results.push({cwd,files,exitCode:result.status,error:result.error?.message??null,durationMs:Date.now()-start,log});
}
report.passed=report.results.every(r=>r.exitCode===0&&!r.error);writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,kind:report.kind,report:join(out,'result.json')}));process.exitCode=report.passed?0:1;
