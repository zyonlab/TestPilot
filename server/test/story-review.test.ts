import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
let dir:string,project:string,service:typeof import('../src/runService.js'),db:typeof import('../src/db.js'),review:typeof import('../src/storyReview.js');
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'tp-story-review-'));vi.stubEnv('TP_DATA_DIR',dir);vi.stubEnv('MIDSCENE_MODEL_NAME','fixture');vi.stubEnv('MIDSCENE_MODEL_BASE_URL','https://fixture.test/v1');vi.stubEnv('MIDSCENE_MODEL_API_KEY','fixture-key');
 db=await import('../src/db.js');service=await import('../src/runService.js');review=await import('../src/storyReview.js');
 project=db.createProject('Draft stories','https://fixture.test').id;
});
afterAll(()=>{service.runLedger().close();db.db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('preserves proposed criteria but requires a version-specific human approval; rejects forged approvals and stale versions',async()=>{
 const runId=service.registerHostRun(project,{runtime:'codex',externalId:'draft',idempotencyKey:'draft',materials:[{name:'scope.md',text:'Explore the order form'}]}).runId;
 const story={id:'S1',title:'Inspect assets',acceptance:['Given an account, when opening assets, show its available balance'],ruleRefs:['R1']};
 review.markCandidateStories([story],[{id:'R1',claimType:'hypothesis'}]);
 expect(story).toHaveProperty('requirementDraft.questions');
 const l=service.runLedger(),put=(parentRevision?:string)=>l.putRevision({runId,projectId:project,name:'validated/stories',kind:'stories',content:{stories:[story]},sourceRefs:[],parentRevision},{kind:'system',id:'validator'});
 const first=put();
 expect(()=>review.requireStoryApproval(runId,project)).toThrow('story_requirements_need_review');
 const controls=await import('../src/workflowControls.js');
 expect(()=>controls.requireStageStarted(runId,project,'cases')).toThrow('story_requirements_need_review');
 l.putRevision({runId,projectId:project,name:'review/story-requirements',kind:'report',content:{approved:true},sourceRefs:[first.id]},{kind:'agent',id:'forger'});
 expect(review.storyReviewState(runId,project).pending).toBe(true);
 expect(()=>review.approveStoryRequirements(runId,project,first.id,{kind:'agent',id:'host'})).toThrow('operator_action_required');
 expect(()=>review.approveStoryRequirements(runId,project,'stale',{kind:'human',id:'user'})).toThrow('story_revision_changed');
 review.approveStoryRequirements(runId,project,first.id,{kind:'human',id:'user'});
 expect(()=>review.requireStoryApproval(runId,project)).not.toThrow();
 story.acceptance.push('When selecting another account, show that account balance');
 const second=put(first.id);expect(second.id).not.toBe(first.id);
 expect(()=>review.requireStoryApproval(runId,project)).toThrow('story_requirements_need_review');
 expect(()=>review.guardStoryResume(runId,project)).toThrow('story_requirements_need_review');
 expect(l.getRun(runId,project).status).toBe('waiting_review');
 expect(l.nodeStates(runId).find(n=>n.node==='stories')?.phase).toBe('waiting_review');
 const {watchRun}=await import('../src/penguin.js');const events:unknown[]=[];
 const result=await new Promise<{status:string;error?:string}>(resolve=>watchRun({runId,sessionId:'fixture',workspace:dir,outDir:dir,scopeProjectId:project,stateOf:()=> 'idle',onEvent:e=>events.push(e),onDone:resolve}));
 expect(result.status).toBe('done');expect(result.error).toBeUndefined();
 expect(events.some((e:any)=>e.node==='gate'&&e.phase==='error')).toBe(false);

});
it('normative stories are not automatically marked as hypotheses',()=>{
 const story={id:'S',title:'Order',acceptance:['valid order accepted'],ruleRefs:['R']};
 review.markCandidateStories([story],[{id:'R',claimType:'normative'}]);expect(story).not.toHaveProperty('requirementDraft');
});

it('native host launch uses the same candidate contract for unit and whole-bundle stories',async()=>{
 const {generationMessage}=await import('../src/runtime/skill-launch.js');
 const {STORY_PLANNING_CONTRACT}=await import('@testpilot/harness-testing/casegen');
 for(const workUnits of [true,false]){
  const message=generationMessage({materialsDir:dir,outDir:join(dir,'run-fixture'),generationMode:'skill',workUnits});
  expect(message).toContain(STORY_PLANNING_CONTRACT);
  expect(message).toContain('Keep proposed criteria in story.acceptance');
  expect(message).toContain('NOT approved requirements or failure criteria');
  expect(message).not.toContain('never an acceptance criterion');
  expect(message).toContain('requiresHumanReview');
 }
});
