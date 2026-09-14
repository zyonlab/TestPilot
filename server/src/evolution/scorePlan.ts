/** Trusted dev probe. Invalid plans are unobservable, never fabricated P0 failures. */
export function scorePlan(plan: any) {
 const valid=!!plan&&!plan.invalidResponse&&typeof plan.selector==='string'&&['number','string'].includes(plan.valueType)&&['unobservable','failed','passed'].includes(plan.missingEvidence)&&typeof plan.expectedAfterIncrement==='number'&&Number.isFinite(plan.expectedAfterIncrement);
 const observation=valid&&plan.selector==='#count'&&plan.valueType==='number';
 const oracle=valid&&plan.expectedAfterIncrement===1&&plan.missingEvidence==='unobservable';
 return {valid,observation,oracle,passed:observation&&oracle,p0Failure:valid&&!oracle,unobservable:!observation};
}
