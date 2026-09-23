/** One cancel callback per workflow; never stop another workflow's browser. */
const sessions = new Map<string, () => Promise<void>>();
export function trackSourceSession(runId: string, cancel: () => Promise<void>) {
  sessions.set(runId, cancel);
  return () => { if (sessions.get(runId) === cancel) sessions.delete(runId); };
}
export async function cancelSourceSession(runId: string) {
  const cancel = sessions.get(runId);
  if (cancel) await cancel();
}
