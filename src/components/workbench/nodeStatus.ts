/** Only an explicit queued event means startup; a node without an event has not started. */
export function nodeStatusKey(phase?:string) {
  return phase === 'partial' ? 'bench.nodePartial' : phase === 'queued' ? 'bench.nodeStarting' : `workflow.status.${phase ?? 'queued'}`;
}

/** A stopped run cannot still have a live startup spinner from an older node event. */
export function displayNodePhase(phase:string|undefined,status:string){
 if(phase!=='queued'&&phase!=='running')return phase;
 if(['failed','cancelled','interrupted'].includes(status))return status==='interrupted'?'blocked':status;
 if(['paused','waiting_review'].includes(status))return 'blocked';
 return phase;
}
