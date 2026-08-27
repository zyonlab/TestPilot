import type { Gate } from "./gate.js";

/**
 * Lending gate slots to other processes.
 *
 * A child cannot hold a mutex that lives in its parent, so it holds a *ticket*: the parent
 * keeps the release function and hands back an id. The bookkeeping exists for one reason —
 * **a child that dies mid-call never reaches its finally**, and a slot lost that way stalls
 * every later call forever. So the host releases everything a dead process held.
 */
export interface GateLending {
  /** The methods to expose to one child process (see Supervisor's extendParentApi). */
  api(processId: string): {
    acquireModel(): Promise<number>;
    releaseModel(ticket: number): Promise<void>;
  };
  /** Release everything this process still holds. Returns how many slots came back. */
  releaseAllFor(processId: string): number;
  /** Outstanding tickets across all processes. */
  outstanding(): number;
}

export function lendGate(gate: Gate): GateLending {
  const held = new Map<string, Map<number, () => void>>();
  let seq = 0;

  return {
    api: (processId) => ({
      acquireModel: async () => {
        const release = await gate.acquire();
        const ticket = ++seq;
        const mine = held.get(processId) ?? new Map<number, () => void>();
        mine.set(ticket, release);
        held.set(processId, mine);
        return ticket;
      },
      releaseModel: async (ticket) => {
        const mine = held.get(processId);
        const release = mine?.get(ticket);
        if (!release) return; // already released, or never ours — releasing twice is not an error
        mine!.delete(ticket);
        release();
      },
    }),
    releaseAllFor: (processId) => {
      const mine = held.get(processId);
      if (!mine?.size) return 0;
      const n = mine.size;
      for (const release of mine.values()) release();
      mine.clear();
      return n;
    },
    outstanding: () => [...held.values()].reduce((n, m) => n + m.size, 0),
  };
}
