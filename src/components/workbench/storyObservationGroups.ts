type Observation={id:string;featureId:string;[key:string]:any};
/** Candidate records help review; they never upgrade criterion verification. */
export function storyObservationGroups(observations:Observation[],featureRefs:string[]=[],observationIds:string[]=[]){
 const cited=new Set(observationIds);
 return {
  linked:observations.filter(o=>cited.has(o.id)),
  related:observations.filter(o=>!cited.has(o.id)&&featureRefs.includes(o.featureId)),
 };
}
