import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {ProjectAssets} from './projectAssets.js';
import {runLedger} from './runService.js';
import {contentHash,LedgerError} from './runLedger.js';
import {readKnowledgeLibrary} from './knowledgeLibrary.js';
import {getProject} from './db.js';
const schema=z.object({mode:z.enum(['incremental','clean','rebuild']),snapshotId:z.string().optional(),configuration:z.record(z.unknown()),label:z.string().min(1).max(200)}).strict();
export function planTable(){runLedger().db.exec('CREATE TABLE IF NOT EXISTS project_run_plans(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,json TEXT NOT NULL,runId TEXT)');}
export function createProjectRunPlan(projectId:string,raw:unknown){
 const input=schema.parse(raw),ledger=runLedger();planTable();
 const configuration={...input.configuration};delete configuration.projectPlanId;delete configuration.idempotencyKey;
 if(configuration.importStories||configuration.importProductModel)throw new LedgerError(400,'plan_imports_must_use_snapshot');
 if(input.mode!=='incremental'&&input.snapshotId)throw new LedgerError(400,'clean_plan_cannot_inherit_snapshot');
 if(input.mode==='incremental'&&!input.snapshotId)throw new LedgerError(400,'incremental_snapshot_required');
 const assets=new ProjectAssets(ledger),snapshot=input.snapshotId?assets.readSnapshot(projectId,input.snapshotId):undefined;
 const knowledge=Array.isArray(configuration.knowledge)?[...configuration.knowledge]:[];
 if(typeof configuration.knowledgeSelection==='string'){const selected=readKnowledgeLibrary(projectId,'domainKnowledge',configuration.knowledgeSelection);knowledge.push({name:'domain-knowledge.md',text:selected.value,roles:['source','stories','cases','gate']});}
 if(typeof configuration.rulePackSelection==='string')configuration.rulePacks=[readKnowledgeLibrary(projectId,'rulePack',configuration.rulePackSelection).value];
 configuration.knowledgeSelection=null;configuration.rulePackSelection=null;
 if(snapshot)for(const id of Object.values(snapshot.heads)){const {version,content}=assets.read(projectId,id);knowledge.push({name:`project-asset-${id}.md`,text:`Reference asset ${version.assetKey} (${id}). This is prior work, not current observation or transferred approval.\n${canonicalJSON(content)}`,roles:['source','stories','cases','gate']});}
 configuration.knowledge=knowledge;
 const id='plan-'+randomUUID(),plan={id,projectId,...input,configuration,createdAt:new Date().toISOString(),snapshot:snapshot??null,lineageId:input.mode==='rebuild'?'line-'+randomUUID():snapshot?.id??'main',reuseExperience:input.mode==='incremental',projectConfigurationHash:contentHash(canonicalJSON(getProject(projectId))),inputDigest:contentHash(canonicalJSON(configuration))};
 ledger.db.prepare('INSERT INTO project_run_plans VALUES(?,?,?,NULL)').run(id,projectId,canonicalJSON(plan));return plan;
}
export function readProjectRunPlan(projectId:string,id:string){planTable();const row=runLedger().db.prepare('SELECT projectId,json,runId FROM project_run_plans WHERE id=?').get(id) as {projectId:string;json:string;runId:string|null}|undefined;if(!row)throw new LedgerError(404,'project_plan_missing');if(row.projectId!==projectId)throw new LedgerError(409,'project_plan_scope');const plan=JSON.parse(row.json) as ReturnType<typeof createProjectRunPlan>;if(contentHash(canonicalJSON(plan.configuration))!==plan.inputDigest)throw new LedgerError(409,'project_plan_changed');return {...plan,runId:row.runId};}
export function projectPlanInputs(projectId:string,id:string){const plan=readProjectRunPlan(projectId,id);if(plan.projectConfigurationHash!==contentHash(canonicalJSON(getProject(projectId))))throw new LedgerError(409,'project_configuration_changed_replan');return {...plan.configuration,projectPlanId:id,projectRunMode:plan.mode,projectLineageId:plan.lineageId,reuseExperience:plan.reuseExperience,idempotencyKey:id};}
