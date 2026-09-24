import {boundRulePack} from './rulePacks.js';
import {businessTransitionIssues} from '@testpilot/harness-testing/casegen';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {randomUUID} from 'node:crypto';
import type {Principal} from '@testpilot/harness-core/run-contracts';
import type {Story} from '@testpilot/harness-testing/casegen';
import {runLedger} from './runService.js';
import {LedgerError} from './runLedger.js';

export function markCandidateStories(stories:Story[],rules:Array<{id:string;claimType:string}>) {
  for(const story of stories){
    const cited=rules.filter(r=>story.ruleRefs?.includes(r.id));
    if(cited.some(r=>r.claimType==='hypothesis') || (rules.length>0&&rules.every(r=>r.claimType==='hypothesis')))
      story.requirementDraft ??= {reason:'来源规则包含未确认假设，验收条件为候选业务预期。',questions:[`请确认「${story.title}」的业务范围与各项候选验收条件，或补充正式需求后重新生成。`]};
  }
}
export function storyReviewState(runId:string,projectId:string){
  const ledger=runLedger();ledger.requireRun(runId,projectId);
  const revisions=ledger.listRevisions(projectId,runId);
  const revision=revisions.filter(r=>r.name==='validated/stories').sort((a,b)=>b.revision-a.revision)[0];
  const transitions=boundRulePack(runId,projectId)?.businessTransitions??[];
  if(!revision)return {pending:false,revisionId:undefined,transitions};
  const content=ledger.readRevision(revision.id,projectId).content as {stories?:Story[]};
  const candidates=(content.stories??[]).filter(s=>s.requirementDraft);
  const approved=revisions.some(r=>r.name==='review/story-requirements'&&r.createdBy.kind==='human'&&r.sourceRefs.includes(revision.id));
  return {pending:candidates.length>0&&!approved,revisionId:revision.id,candidates,stories:content.stories??[],transitions,transitionFindings:businessTransitionIssues(content.stories??[],transitions)};
}
export function requireStoryApproval(runId:string,projectId:string){
  if(storyReviewState(runId,projectId).pending)throw new LedgerError(409,'story_requirements_need_review: 请在用户故事节点审核候选业务预期；不能将假设直接用于用例设计。');
}
/** Persist the review stop before returning from a stage transaction (do not throw and roll it back). */
export function pauseForStoryReview(runId:string,projectId:string){
 const ledger=runLedger(),state=storyReviewState(runId,projectId);if(!state.pending)return false;
 ledger.db.transaction(()=>{
  for(const node of ledger.nodeStates(runId))if(['cases','gate','finalize','g2','execution'].includes(node.node)&&['queued','running'].includes(node.phase)){
   const sequence=(ledger.db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workflow_events WHERE runId=? AND node=? AND attempt=?').get(runId,node.node,node.attempt) as {n:number}).n;
   ledger.appendEvent({id:'stage-'+randomUUID(),runId,node:node.node,attempt:node.attempt,sequence,at:new Date().toISOString(),phase:'blocked',message:'等待本次运行的候选故事审核；尚未开始用例设计。'},projectId);
  }
  if(ledger.nodeStates(runId).find(n=>n.node==='stories')?.phase!=='waiting_review')storyReviewEvent(runId,projectId,'waiting_review',state.revisionId!);
  const detail={...ledger.getRun(runId,projectId).detail};if(detail.error){detail.adapterDiagnostic=detail.error;delete detail.error;}
  ledger.db.prepare("UPDATE wf_runs SET status='waiting_review',json=? WHERE id=?").run(canonicalJSON(detail),runId);
 })();return true;
}
export function guardStoryResume(runId:string,projectId:string){
  const ledger=runLedger(),state=storyReviewState(runId,projectId);
  if(!state.pending)return;
  if(['running','queued'].includes(ledger.getRun(runId,projectId).status))throw new LedgerError(409,'host_still_running');
  pauseForStoryReview(runId,projectId);
  requireStoryApproval(runId,projectId);
}
export function storyReviewEvent(runId:string,projectId:string,phase:'waiting_review'|'done',revisionId:string){
  const ledger=runLedger();
  const sequence=(ledger.db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workflow_events WHERE runId=? AND node=? AND attempt=0').get(runId,'stories') as {n:number}).n;
  ledger.appendEvent({id:'stage-'+randomUUID(),runId,node:'stories',attempt:0,sequence,at:new Date().toISOString(),phase,revisionId,message:phase==='waiting_review'?'候选需求待人工确认：请审核故事中的业务预期和问题。':'候选业务预期已由用户确认。'},projectId);
}
export function approveStoryRequirements(runId:string,projectId:string,revisionId:string,principal:Principal){
  if(principal.kind!=='human')throw new LedgerError(403,'operator_action_required');
  const ledger=runLedger();return ledger.db.transaction(()=>{
    const state=storyReviewState(runId,projectId);
    if(state.revisionId!==revisionId)throw new LedgerError(409,'story_revision_changed');
    if(['running','queued'].includes(ledger.getRun(runId,projectId).status))throw new LedgerError(409,'host_still_running');
    if(!state.pending)return state;
    const prior=ledger.listRevisions(projectId,runId).filter(r=>r.name==='review/story-requirements').sort((a,b)=>b.revision-a.revision)[0];
    ledger.putRevision({runId,projectId,name:'review/story-requirements',kind:'report',content:{revisionId,approvedBy:principal,at:new Date().toISOString()},sourceRefs:[revisionId],parentRevision:prior?.id},principal);
    storyReviewEvent(runId,projectId,'done',revisionId);
    ledger.db.prepare("UPDATE wf_runs SET status='paused' WHERE id=?").run(runId);
    return {pending:false,revisionId};
  })();
}
