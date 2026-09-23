/** Only an explicit queued event means startup; a node without an event has not started. */
export function nodeStatusKey(phase?:string) {
  return phase === 'partial' ? 'bench.nodePartial' : phase === 'queued' ? 'bench.nodeStarting' : `workflow.status.${phase ?? 'queued'}`;
}
