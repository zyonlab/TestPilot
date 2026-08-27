// A supervised child stand-in. Env flags drive the behaviours the supervisor tests need:
//   HB_MS=<n>            heartbeat every n ms (0/unset = never beat, to test the liveness sweep)
//   EMIT_ON_START=1      publish one event upward right after boot
//   EXIT_AFTER_MS=<n>    exit on its own (crash simulation)
//   EXIT_CODE=<n>        exit code for the above (default 1)
//   IGNORE_SHUTDOWN=1    do not honour rpc.shutdown(), forcing the signal path
import { createBirpc } from "birpc";

const rpc = createBirpc(
  {
    health: async () => ({ ok: true, detail: process.env.TP_PROCESS_ID }),
    // Take a model slot from the supervisor, hold it, give it back — the same shape the
    // runner uses around every model call.
    lease: async (holdMs) => {
      const ticket = await rpc.acquireModel();
      const granted = Date.now();
      await new Promise((r) => setTimeout(r, holdMs));
      // Stamped BEFORE handing the slot back: the supervisor grants the next waiter while
      // it processes this call, so a timestamp taken afterwards would race with that grant.
      const holdEnd = Date.now();
      await rpc.releaseModel(ticket);
      return { ticket, granted, holdEnd };
    },
    /** Take a slot and never give it back (then the process is killed). */
    leaseAndHold: async () => rpc.acquireModel(),
    /** 收到调用后就死，永远不回复——用来验证在途调用会被死讯结掉，而不是永远挂着。 */
    dieMidCall: async () => {
      setTimeout(() => process.exit(9), 10);
      return new Promise(() => {}); // 永不 resolve
    },
    boom: async () => {
      throw new Error("kaboom: the child failed for a specific, readable reason");
    },
    shutdown: async () => {
      if (process.env.IGNORE_SHUTDOWN === "1") return;
      setTimeout(() => process.exit(0), 5);
    },
  },
  {
    post: (data) => process.send({ __rpc: data }),
    on: (fn) => process.on("message", (m) => m && m.__rpc && fn(m.__rpc)),
    eventNames: ["emit", "heartbeat"],
  },
);

// Mirrors startChild(): die with the supervisor instead of becoming an orphan.
process.on("disconnect", () => process.exit(0));

const hb = Number(process.env.HB_MS ?? 0);
let calls = 0;
if (hb > 0) {
  setInterval(() => {
    calls += 1;
    rpc.heartbeat({
      at: new Date().toISOString(),
      task: `task-${calls}`,
      spend: { calls, tokens: calls * 10, usd: 0, ms: calls * hb },
    });
  }, hb);
}

if (process.env.EMIT_ON_START === "1") rpc.emit("log", { stream: "rpc", text: "child up" });
if (process.env.EMIT_BAD === "1") {
  rpc.emit("", { nothing: true }); // empty kind
  rpc.emit("log", { text: "bad scope" }, { runId: 42 }); // scope field of the wrong type
}

const exitAfter = Number(process.env.EXIT_AFTER_MS ?? 0);
if (exitAfter > 0) setTimeout(() => process.exit(Number(process.env.EXIT_CODE ?? 1)), exitAfter);

setInterval(() => {}, 1 << 30); // stay alive until told otherwise
