import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import{tmpdir}from'node:os';
let dir:string,runId:string,projectId:string,spend:typeof import('../src/roleSpend.js'),service:typeof import('../src/runService.js'),db:typeof import('../src/db.js');
beforeAll(async()=>{dir=mkdtempSync(join(tmpdir(),'tp-spend-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://fixture.test/v1');db=await import('../src/db.js');service=await import('../src/runService.js');spend=await import('../src/roleSpend.js');projectId=db.createProject('spend','http://localhost').id;runId=service.registerHostRun(projectId,{runtime:'codex',externalId:'spend',idempotencyKey:'spend',materials:[{name:'spec.md',text:'fixture'}]}).runId;});
afterAll(()=>{service.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('unknown host spend is not zero, request records persist exactly once and remain project scoped',()=>{
 expect(spend.runRoleSpend(runId,projectId).roles[0]).toMatchObject({coverage:'unknown',calls:null,estimatedUsd:null});
 const record={requestId:'one',role:'executor' as const,model:'fixture',endpoint:'https://fixture.test/v1',thinking:false,status:200,ms:20,at:'2026-09-09T00:00:00.000Z',forwarded:true,usage:{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:80}};
 spend.recordModelRequests(runId,[record]);spend.recordModelRequests(runId,[record]);const report=spend.runRoleSpend(runId,projectId);expect(report.records).toHaveLength(1);expect(report.roles[1]).toMatchObject({calls:1,inputTokens:100,outputTokens:20,cachedInputTokens:80,estimatedUsd:null});
 expect(()=>spend.runRoleSpend(runId,'wrong')).toThrow('run_project_conflict');expect(()=>spend.recordModelRequests(runId,[{...record,ms:21}])).toThrow('spend_identity_conflict');
});
it('normalizes Anthropic cache-inclusive input and preserves host cost without making up requests',()=>{
 const usage={input_tokens:10,output_tokens:30,cache_read_input_tokens:100,cache_creation_input_tokens:20};spend.recordHostSummary(runId,'claude-code','synthetic',usage,'fixture',0.2);spend.recordHostSummary(runId,'claude-code','synthetic',usage,'fixture',0.2);
 expect(spend.runRoleSpend(runId,projectId).roles[0]).toMatchObject({calls:null,inputTokens:130,totalTokens:160,cacheWriteTokens:20,reportedUsd:0.2,estimatedUsd:null});
});
it('uses dated model prices and does not subtract overlapping caches or guess missing rates',()=>{
 const row=spend.SpendRecordSchema.parse({id:'priced',runId,role:'planner',source:'role-proxy',model:'fixture',endpoint:'https://fixture.test/v1',at:'2026-09-09T00:00:00.000Z',ms:2,inputTokens:100,outputTokens:20,cachedInputTokens:50,cacheWriteTokens:10,totalTokens:120,forwarded:true,httpStatus:200});
 const price={id:'fixture-price',model:'fixture',endpoint:'https://fixture.test/v1',validFrom:'2026-01-01T00:00:00.000Z',inputUsdPerMillion:1,outputUsdPerMillion:2,cachedInputUsdPerMillion:0.1,cacheWriteUsdPerMillion:1.5};
 expect(spend.priceSpend(row,[price]).estimatedUsd).toBeCloseTo(0.0001);
 expect(spend.priceSpend({...row,cachedInputTokens:95},[price]).priceReason).toBe('incompatible_cache_usage');expect(spend.priceSpend(row,[price,price]).estimatedUsd).toBeNull();
 expect(spend.priceSpend({...row,inputTokens:null},[price]).estimatedUsd).toBeNull();
});
