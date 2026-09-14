/** Called by a trusted CI job, outside candidate write authority. Stop hooks are advisory. */
import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{resolve,relative,isAbsolute}from'node:path';
export const sha256=s=>createHash('sha256').update(s).digest('hex');
export function verifyExport(directory,expectedHash){
 if(!expectedHash)return {status:'blocked',reason:'approved_export_hash_missing'};
 try{const raw=readFileSync(resolve(directory,'testpilot-manifest.json'));if(sha256(raw)!==expectedHash)return{status:'blocked',reason:'approval_binding_mismatch'};const manifest=JSON.parse(raw);for(const[p,want]of Object.entries(manifest.files)){const full=resolve(directory,p),rel=relative(directory,full);if(isAbsolute(p)||rel==='..'||rel.startsWith('../'))return{status:'blocked',reason:'unsafe_path'};if(sha256(readFileSync(full))!==want)return{status:'blocked',reason:'artifact_modified',path:p};}return{status:'verified',manifestHash:expectedHash,cases:manifest.cases};}catch{return{status:'blocked',reason:'export_unreadable'};}
}
export function assessP0({integrity,report,executedManifestHash,startedAt,finishedAt,now=Date.now(),maxAgeMs=30*60*1000}){
 const blocked=reason=>({status:'blocked',reason,allowMerge:false});
 if(integrity.status!=='verified')return blocked(integrity.reason);
 if(executedManifestHash!==integrity.manifestHash)return blocked('execution_binding_mismatch');
 const start=Date.parse(startedAt),end=Date.parse(finishedAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end>now+5000||now-end>maxAgeMs)return blocked('execution_not_fresh');
 if(!report||report.errors?.length)return blocked('runner_error');
 const specs=[];const visit=s=>{specs.push(...(s.specs??[]));for(const child of s.suites??[])visit(child);};visit(report);
 const p0=specs.filter(s=>s.title.includes('@P0'));if(!p0.length)return blocked('no_p0_results');
 const expected=integrity.cases.filter(c=>c.priority==='P0');if(!expected.length||p0.length!==expected.length)return blocked('incomplete_p0_set');
 const results=p0.flatMap(s=>(s.tests??[]).flatMap(t=>t.results??[]));if(results.length<p0.length||results.some(r=>!['passed','failed'].includes(r.status)))return blocked('missing_or_unfinished_results');
 const errors=results.flatMap(r=>[r.error?.message??'',...(r.errors??[]).map(e=>e.message??'')]).join('\n');
 if(/ORACLE_UNOBSERVABLE|ENV_TEARDOWN_FAILED|ECONNREFUSED|net::ERR|Timeout|timed out|MODEL_UNAVAILABLE|BUDGET_EXHAUSTED/i.test(errors))return blocked('infrastructure_or_unobservable');
 const failed=results.filter(r=>r.status!=='passed').length;return{status:failed?'failed':'passed',allowMerge:failed===0,p0Cases:p0.length,attempts:results.length,failedAttempts:failed};
}
