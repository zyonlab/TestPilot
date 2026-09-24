import type {BusinessTransition} from '../domain/businessLifecycle.js';
import type {Story} from './types.js';
/** Planning consumes evidence; it does not certify execution. */
export const STORY_PLANNING_CONTRACT = [
 'Business lifecycle coverage is the goal, not the minimum story count. For every supplied businessTransitions entry, propose goal-oriented stories including its prerequisites, trigger, result and relevant failure/recovery behavior. A current empty state never removes a capability. A pending resource and an established resource are different states. Missing observation limits evidence, not candidate story scope. Do not move an entire user goal into a question instead of proposing it.',
 'Bind coverage on each story with businessTransitions:[{transitionId,preconditions:[copy all declared prerequisite statements; add refinements if needed],acceptanceIndexes:[0-based success criteria],failureAcceptanceIndexes:[0-based distinct rejection/recovery criteria]}]. Cite only transitions whose featureId is in featureRefs. The criteria must actually express those behaviors; indexes alone do not prove semantic coverage. Hypothesis transitions require requirementDraft. No transition declaration means lifecycle coverage is unknown, not complete. State preparation is a proposal, never authorization to execute.',
 'Plan user stories from the approved module plan, product requirements and applicable normative rules. Exploration is supporting evidence, not a prerequisite for a valid requirement.',
 'Write acceptance criteria as required business behavior. Do not append 【待确认：界面观察不到】 or requires-fixture merely because exploration did not execute a flow.',
 'Before assigning observationLinks, inspect supplied same-feature actions, controlsAfter and effects. Cite records supporting a specific part of a criterion as partial; full observed requires the entire outcome. Keep unrelated candidates separate. Do not blanket-label every criterion not_attempted or omit relevant attempted records. nextSteps should name the remaining action or missing result.',
 'Keep observed/partial/unobserved coverage only in observationLinks. Missing observation must not imply missing fixture, unsupported product functionality, or an invalid story.',
 'Only unclear product scope or conflicting requirements deserve a requirement question; cite the conflict or missing product decision. Do not promote unsupported hypotheses into requirements.',
 'When requirements are hypotheses or missing, still produce candidate stories and proposed acceptance criteria, with requirementDraft:{reason,questions:[specific business decisions to confirm]}. These are proposals for human review, NOT approved requirements or failure criteria. Do not stop merely because normative rules are missing. Cite the source of each proposal without claiming it proves correctness. The server prevents case design until a human approves the story revision.',
 'Cases consume the approved stories and acceptance ids. Design steps, expected outcomes and explicit prerequisites even when they have not been executed. Assess execution readiness separately during preparation; never invent verification or machine-oracle evidence.',
].join('\n');
export function storyPlanningIssues(stories:Array<{acceptance:string[]}>) {
 return stories.flatMap((story,i)=>story.acceptance.flatMap((text,j)=>
  /【待确认[：:]\s*界面观察不到】/.test(text)
   ? [{code:'observation_gap_in_requirement',jsonPointer:`/stories/${i}/acceptance/${j}`,message:'验收条件描述业务要求；将未观察状态放入 observationLinks，不要写成需求待确认。'}] : []));
}

/** Structural coverage only. Human review still judges the meaning of the criteria. */
export function businessTransitionIssues(stories:Story[],transitions:BusinessTransition[],requireCoverage=true){
 const issues:Array<{code:string;jsonPointer:string;message:string}>=[];
 const covered=new Set<string>();
 stories.forEach((story,i)=>(story.businessTransitions??[]).forEach((binding,j)=>{
  const pointer=`/stories/${i}/businessTransitions/${j}`,t=transitions.find(t=>t.id===binding.transitionId);
  const fail=(code:string,message:string)=>issues.push({code,jsonPointer:pointer,message});
  if(!t){fail('unknown_business_transition',binding.transitionId);return;}
  const before=issues.length;
  if(!story.featureRefs?.includes(t.featureId))fail('transition_feature_mismatch',t.featureId);
  if(t.preconditions.some(p=>!binding.preconditions.includes(p)))fail('transition_prerequisites_missing',t.preconditions.join('; '));
  const success=binding.acceptanceIndexes,failure=binding.failureAcceptanceIndexes;
  if(!success.length||!failure.length||[...success,...failure].some(n=>!Number.isInteger(n)||n<0||n>=story.acceptance.length)||failure.some(n=>success.includes(n)))fail('transition_acceptance_invalid','Bind distinct, existing success and failure criteria');
  if(t.claimType==='hypothesis'&&!story.requirementDraft)fail('transition_requires_draft',t.id);
  if(before===issues.length)covered.add(t.id);
 }));
 if(requireCoverage)for(const t of transitions)if(!covered.has(t.id))issues.push({code:'business_transition_uncovered',jsonPointer:'/stories',message:`${t.id}: ${t.preconditions.join('; ')} → ${t.action} → ${t.outcome}. Include failure/recovery behavior; missing observation is not an exclusion.`});
 return issues;
}
