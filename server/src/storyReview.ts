import {boundRulePack} from './rulePacks.js';
import {businessTransitionIssues} from '@testpilot/harness-testing/casegen';
import {canonicalJSON} from '@testpilot/harness-core/run-contracts';
import {randomUUID} from 'node:crypto';
import type {Principal} from '@testpilot/harness-core/run-contracts';
import type {Story} from '@testpilot/harness-testing/casegen';
import {runLedger} from './runService.js';
import {LedgerError,contentHash} from './runLedger.js';

export function markCandidateStories(stories:Story[],rules:Array<{id:string;claimType:string}>) {
  for(const story of stories){
    const cited=rules.filter(r=>story.ruleRefs?.includes(r.id));
    if(cited.some(r=>r.claimType==='hypothesis') || (rules.length>0&&rules.every(r=>r.claimType==='hypothesis')))
      story.requirementDraft ??= {reason:'来源规则包含未确认假设，验收条件为候选业务预期。',questions:[`请确认「${story.title}」的业务范围与各项候选验收条件，或补充正式需求后重新生成。`]};
  }
}
/** Approval reuse is limited to a verified downstream fork with unchanged business inputs. */
/**
 * 环境画像只在父运行记录过时才比（2026-09-24 起新运行才有 environmentProfile）：更早的运行没有这项，
 * 不替它补一个值，也不因为它缺这项就把整条审批链判废——材料、知识、模块、探索证据与目标照比。
 */
const recordsEnvironment=(runId:string,projectId:string)=>typeof runLedger().requireRun(runId,projectId).input.parameters?.environmentProfile==='string';
function reviewContext(runId:string,projectId:string,withEnvironment=true){
 const l=runLedger(),run=l.requireRun(runId,projectId),latest=[...new Map(l.listRevisions(projectId,runId).map(r=>[r.kind+':'+r.name,r])).values()];
 return contentHash(canonicalJSON({environment:run.binding.environmentHash,...(withEnvironment&&typeof run.input.parameters?.environmentProfile==='string'?{environmentProfile:run.input.parameters.environmentProfile}:{}),target:Object.fromEntries(['sourceUrl','targetUrl','envRef','exploreWallet'].map(k=>[k,run.input.parameters?.[k]??null])),materials:run.binding.materialRevisions.map(id=>{const r=l.readRevision(id,projectId).revision;return [r.name,r.contentHash];}).sort(),knowledge:latest.filter(r=>r.name.startsWith('knowledge/')||['validated/modules','product/model-candidate','exploration/report'].includes(r.name)).map(r=>[r.kind,r.name,r.contentHash]).sort()}));
}
function approvedRevision(runId:string,projectId:string,storyId:string,seen=new Set<string>()):string|undefined{
 if(seen.has(storyId))return;seen.add(storyId);const l=runLedger(),story=l.readRevision(storyId,projectId).revision;if(story.runId!==runId||story.name!=='validated/stories')return;
 const revisions=l.listRevisions(projectId,runId);
 const direct=revisions.find(r=>r.name==='review/story-requirements'&&r.createdBy.kind==='human'&&r.sourceRefs.includes(storyId));if(direct)return direct.id;
 for(const r of revisions.filter(r=>r.name==='review/story-requirements-inherited'&&r.createdBy.kind==='system'&&r.createdBy.id==='story-approval-inheritance'&&r.sourceRefs.includes(storyId))){
  const c=l.readRevision(r.id,projectId).content as any;
  if(typeof c.parentRunId!=='string'||typeof c.parentStoryId!=='string'||!story.sourceRefs.includes(c.parentStoryId))continue;
  const parent=l.readRevision(c.parentStoryId,projectId).revision;
  const env=c.environmentChecked!==false;
  if(parent.runId!==c.parentRunId||parent.contentHash!==story.contentHash||c.contextDigest!==reviewContext(runId,projectId,env)||c.contextDigest!==reviewContext(c.parentRunId,projectId,env))continue;
  const approval=approvedRevision(c.parentRunId,projectId,c.parentStoryId,seen);
  if(approval&&approval===c.parentApprovalId&&r.sourceRefs.includes(approval))return r.id;
 }
}
export function inheritStoryApproval(parentRunId:string,runId:string,projectId:string){
 const l=runLedger();l.requireRun(parentRunId,projectId);l.requireRun(runId,projectId);
 const parent=l.listRevisions(projectId,parentRunId).filter(r=>r.name==='validated/stories').at(-1),story=l.listRevisions(projectId,runId).filter(r=>r.name==='validated/stories').at(-1);
 if(!parent||!story||parent.contentHash!==story.contentHash||!story.sourceRefs.includes(parent.id))return false;
 const origin=l.listRevisions(projectId,runId).find(r=>r.name==='report/rerun-origin'&&r.createdBy.kind==='system'&&r.createdBy.id==='rerun');
 if(!origin)return false;const o=l.readRevision(origin.id,projectId).content as any;
 if(o.parentRunId!==parentRunId||!['cases','gate'].includes(o.fromNode))return false;
 const env=recordsEnvironment(parentRunId,projectId);
 const approval=approvedRevision(parentRunId,projectId,parent.id),digest=reviewContext(runId,projectId,env);
 if(!approval||digest!==reviewContext(parentRunId,projectId,env))return false;
 if(approvedRevision(runId,projectId,story.id))return true;
 const prior=l.listRevisions(projectId,runId).filter(r=>r.name==='review/story-requirements-inherited').at(-1);
 l.putRevision({runId,projectId,name:'review/story-requirements-inherited',kind:'report',content:{parentRunId,parentStoryId:parent.id,parentApprovalId:approval,contextDigest:digest,environmentChecked:env,reason:env?'Unchanged stories and business inputs copied for downstream rerun':'Unchanged stories and business inputs copied for downstream rerun; the parent run predates environment profiles, so environment was not compared'},sourceRefs:[story.id,parent.id,approval,origin.id],parentRevision:prior?.id},{kind:'system',id:'story-approval-inheritance'});
 storyReviewEvent(runId,projectId,'done',story.id,'沿用未变更故事的既有人工审批，来源运行 '+parentRunId);return true;
}
export function storyReviewState(runId:string,projectId:string){
  const ledger=runLedger();ledger.requireRun(runId,projectId);
  const revisions=ledger.listRevisions(projectId,runId);
  const revision=revisions.filter(r=>r.name==='validated/stories').sort((a,b)=>b.revision-a.revision)[0];
  const transitions=boundRulePack(runId,projectId)?.businessTransitions??[];
  if(!revision)return {pending:false,revisionId:undefined,transitions};
  const content=ledger.readRevision(revision.id,projectId).content as {stories?:Story[]};
  const candidates=(content.stories??[]).filter(s=>s.requirementDraft);
  const approvalRevisionId=approvedRevision(runId,projectId,revision.id),approved=!!approvalRevisionId;
  const approval=approvalRevisionId?ledger.readRevision(approvalRevisionId,projectId):undefined;
  const inheritedFromRun=approval?.revision.name==='review/story-requirements-inherited'?(approval.content as {parentRunId:string}).parentRunId:undefined;
  const rejection=approved?undefined:storyRejection(runId,projectId,revision.id);
  return {pending:candidates.length>0&&!approved,approvalRevisionId,inheritedFromRun,...(rejection?{rejection:{note:rejection.note,at:rejection.at}}:{}),revisionId:revision.id,candidates,stories:content.stories??[],transitions,transitionFindings:businessTransitionIssues(content.stories??[],transitions)};
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
  const origin=ledger.listRevisions(projectId,runId).find(r=>r.name==='report/rerun-origin'&&r.createdBy.kind==='system'&&r.createdBy.id==='rerun');
  if(origin){const c=ledger.readRevision(origin.id,projectId).content as {parentRunId:string};if(inheritStoryApproval(c.parentRunId,runId,projectId))return;}
  pauseForStoryReview(runId,projectId);
  requireStoryApproval(runId,projectId);
}
export function storyReviewEvent(runId:string,projectId:string,phase:'waiting_review'|'done',revisionId:string,message?:string){
  const ledger=runLedger();
  const sequence=(ledger.db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workflow_events WHERE runId=? AND node=? AND attempt=0').get(runId,'stories') as {n:number}).n;
  ledger.appendEvent({id:'stage-'+randomUUID(),runId,node:'stories',attempt:0,sequence,at:new Date().toISOString(),phase,revisionId,message:message??(phase==='waiting_review'?'候选需求待人工确认：请审核故事中的业务预期和问题。':'候选业务预期已由用户确认。')},projectId);
}
/**
 * 驳回候选故事（2026-09-24）：原先只有「全部批准」。驳回必须写理由（与用例复核同一口径，去掉首尾空白至少 4 个字），
 * 理由留在这次运行上；从故事节点重跑时它作为审核意见带进新运行（rerunProjectNode）。驳回后故事仍待审，不会进入用例设计。
 */
export function rejectStoryRequirements(runId:string,projectId:string,revisionId:string,note:unknown,principal:Principal){
  if(principal.kind!=='human')throw new LedgerError(403,'operator_action_required');
  const reason=typeof note==='string'?note.trim():'';
  if(reason.length<4)throw new LedgerError(400,'rejection_requires_reason');
  const ledger=runLedger();return ledger.db.transaction(()=>{
    const state=storyReviewState(runId,projectId);
    if(state.revisionId!==revisionId)throw new LedgerError(409,'story_revision_changed');
    if(['running','queued'].includes(ledger.getRun(runId,projectId).status))throw new LedgerError(409,'host_still_running');
    if(!state.pending)throw new LedgerError(409,'story_requirements_not_pending');
    const prior=ledger.listRevisions(projectId,runId).filter(r=>r.name==='review/story-requirements-rejected').sort((a,b)=>b.revision-a.revision)[0];
    ledger.putRevision({runId,projectId,name:'review/story-requirements-rejected',kind:'report',content:{revisionId,note:reason,rejectedBy:principal,at:new Date().toISOString()},sourceRefs:[revisionId],parentRevision:prior?.id},principal);
    storyReviewEvent(runId,projectId,'waiting_review',revisionId,'已驳回候选故事：'+reason.slice(0,200)+'。从故事节点重跑会带上这条意见。');
    return {...storyReviewState(runId,projectId)};
  })();
}
/** 这一版故事最近一次被驳回的意见（没有就是 undefined）。 */
export function storyRejection(runId:string,projectId:string,revisionId?:string){
  const l=runLedger(),r=l.listRevisions(projectId,runId).filter(x=>x.name==='review/story-requirements-rejected'&&x.createdBy.kind==='human'&&(!revisionId||x.sourceRefs.includes(revisionId))).sort((a,b)=>b.revision-a.revision)[0];
  return r?(l.readRevision(r.id,projectId).content as {note:string;at:string;revisionId:string}):undefined;
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
