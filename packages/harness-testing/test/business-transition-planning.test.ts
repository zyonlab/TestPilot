import {it,expect} from 'vitest';
import {businessTransitionIssues} from '../src/casegen/planningContract.js';
import {StorySchema} from '../src/casegen/types.js';
import {BusinessTransitionSchema} from '../src/domain/businessLifecycle.js';
const transition=BusinessTransitionSchema.parse({id:'resource.close',featureId:'resource.close',name:'Close resource',claimType:'hypothesis',sourceRefs:['spec'],preconditions:['An owned active resource exists'],action:'Close',outcome:'Resource closed',failureModes:['Pending close rejected'],preparation:'Prepare an owned resource with authorization'});
const story=()=>StorySchema.parse({id:'S1',title:'Close active resource',featureRefs:['resource.close'],requirementDraft:{reason:'Candidate',questions:['Confirm supported close conditions']},acceptance:['Given an active resource, when closed, its terminal state is shown','When closing is rejected, resource remains active and reason is shown'],businessTransitions:[{transitionId:transition.id,preconditions:transition.preconditions,acceptanceIndexes:[0],failureAcceptanceIndexes:[1]}],observationLinks:[{acceptanceIndex:0,status:'unobserved',reason:'requires_fixture',observationIds:[],nextSteps:['Prepare resource']}]});
it('accepts an unobserved lifecycle candidate, rejects inspect-only replacement',()=>{
 expect(businessTransitionIssues([story()],[transition])).toEqual([]);
 expect(businessTransitionIssues([StorySchema.parse({id:'view',title:'Inspect empty table',acceptance:['Empty message shown']})],[transition]).map(x=>x.code)).toContain('business_transition_uncovered');
});
it('rejects forged references, missing prerequisites, invalid ACs and unapproved hypotheses',()=>{
 const s=story();s.businessTransitions![0].transitionId='unknown';expect(businessTransitionIssues([s],[transition])[0].code).toBe('unknown_business_transition');
 const bad=story();bad.businessTransitions![0].preconditions=[];bad.businessTransitions![0].failureAcceptanceIndexes=[0,9];delete bad.requirementDraft;bad.featureRefs=[];
 expect(businessTransitionIssues([bad],[transition]).map(x=>x.code)).toEqual(expect.arrayContaining(['transition_prerequisites_missing','transition_acceptance_invalid','transition_requires_draft','transition_feature_mismatch','business_transition_uncovered']));
});
it('keeps legacy stories compatible and journeys do not need to duplicate every transition',()=>{
 expect(businessTransitionIssues([StorySchema.parse({id:'old',title:'Old'})],[])).toEqual([]);
 expect(businessTransitionIssues([],[transition],false)).toEqual([]);
});
