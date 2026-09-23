/** Planning consumes evidence; it does not certify execution. */
export const STORY_PLANNING_CONTRACT = [
 'Plan user stories from the approved module plan, product requirements and applicable normative rules. Exploration is supporting evidence, not a prerequisite for a valid requirement.',
 'Write acceptance criteria as required business behavior. Do not append 【待确认：界面观察不到】 or requires-fixture merely because exploration did not execute a flow.',
 'Before assigning observationLinks, inspect supplied same-feature actions, controlsAfter and effects. Cite records supporting a specific part of a criterion as partial; full observed requires the entire outcome. Keep unrelated candidates separate. Do not blanket-label every criterion not_attempted or omit relevant attempted records. nextSteps should name the remaining action or missing result.',
 'Keep observed/partial/unobserved coverage only in observationLinks. Missing observation must not imply missing fixture, unsupported product functionality, or an invalid story.',
 'Only unclear product scope or conflicting requirements deserve a requirement question; cite the conflict or missing product decision. Do not promote unsupported hypotheses into requirements.',
 'Cases consume the approved stories and acceptance ids. Design steps, expected outcomes and explicit prerequisites even when they have not been executed. Assess execution readiness separately during preparation; never invent verification or machine-oracle evidence.',
].join('\n');
export function storyPlanningIssues(stories:Array<{acceptance:string[]}>) {
 return stories.flatMap((story,i)=>story.acceptance.flatMap((text,j)=>
  /【待确认[：:]\s*界面观察不到】/.test(text)
   ? [{code:'observation_gap_in_requirement',jsonPointer:`/stories/${i}/acceptance/${j}`,message:'验收条件描述业务要求；将未观察状态放入 observationLinks，不要写成需求待确认。'}] : []));
}
