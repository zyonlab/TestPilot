import { connect } from "node:net";
import type { CapabilityRecipe } from "../config/types.js";
import type { ExecProcSpec } from "./supervisor.js";

/**
 * A capability is an external service the harness can start, watch and stop: a local
 * chain, the model proxy, a mock backend, a device bridge.
 *
 * The recipe is declarative for a reason — the plan is for people to add capabilities by
 * asking the agent for one, and a generated *config* is reproducible and reviewable while
 * a generated *spawn call* is neither.
 */
export function capabilityToSpec(recipe: CapabilityRecipe): ExecProcSpec {
  return {
    id: recipe.id,
    kind: "exec",
    command: recipe.command,
    args: recipe.args,
    env: recipe.env,
    cwd: recipe.cwd,
    // Capabilities are infrastructure: if one dies, the work depending on it is stuck,
    // so bring it back. (Runners are the opposite — see the supervisor's restart notes.)
    restart: "always",
    healthcheck: recipe.healthcheck ? healthProbe(recipe) : undefined,
    healthIntervalMs: recipe.healthIntervalMs ?? 2000,
  };
}

/**
 * "Running" is not "ready": anvil holds the port open before it answers RPC, and a proxy
 * process exists long before its upstream does. Every recipe should say how to ask.
 */
export function healthProbe(recipe: CapabilityRecipe): () => Promise<boolean> {
  const hc = recipe.healthcheck;
  if (!hc) return async () => true;
  if (hc.kind === "tcp") return () => tcpOpen(hc.host ?? "127.0.0.1", hc.port);
  if (hc.kind === "http")
    return async () => {
      try {
        const res = await fetch(hc.url, { headers: hc.headers, signal: AbortSignal.timeout(2000) });
        return hc.expectStatus ? res.status === hc.expectStatus : res.ok;
      } catch {
        return false;
      }
    };
  return async () => {
    try {
      const res = await fetch(hc.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: hc.method, params: [] }),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { result?: unknown };
      return body.result !== undefined;
    } catch {
      return false;
    }
  };
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
