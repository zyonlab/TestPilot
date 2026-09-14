/**
 * How code that calls the model asks for admission.
 *
 * The executor lives in a package that runs in several processes, so it cannot own the
 * gate: whoever owns the process wires the lease in at startup (the gateway binds its own
 * Gate; a runner binds an RPC to the gateway's). Unbound, it is a pass-through — a unit
 * test should not have to know this exists.
 */
export type ModelLease = <T>(fn: () => Promise<T>) => Promise<T>;

let lease: ModelLease = (fn) => fn();

export function setModelLease(next: ModelLease): void {
  lease = next;
}

/** Wrap one model call. Granularity is deliberately one call, not one run. */
export function withModel<T>(fn: () => Promise<T>): Promise<T> {
  return lease(fn);
}
