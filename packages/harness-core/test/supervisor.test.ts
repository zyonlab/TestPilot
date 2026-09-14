import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { EventBus } from "../src/obs/bus.js";
import { EventKind, type Envelope } from "../src/obs/envelope.js";
import { MemoryEventStore } from "../src/obs/store.js";
import { Supervisor } from "../src/harness/supervisor.js";
import { Gate } from "../src/model/gate.js";
import { lendGate } from "../src/model/lending.js";
import type { ChildApi } from "../src/harness/protocol.js";
import { isAlive, until } from "./helpers.js";

const CHILD = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));

let sup: Supervisor | undefined;
const make = (opts?: { monitorMs?: number; missedBeats?: number }) => {
  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  sup = new Supervisor(bus, opts);
  return { sup, bus, events };
};

afterEach(async () => {
  await sup?.stopAll();
  sup = undefined;
});

describe("Supervisor", () => {
  it("reads as idle before it is started — never-started is not the same as exited", () => {
    const { sup } = make();
    sup.register({ id: "later", kind: "node", entry: CHILD, restart: "never" });
    expect(sup.statusOf("later")).toMatchObject({ state: "idle", restarts: 0 });
  });

  it("starts a node child, reaches alive, and answers RPC", async () => {
    const { sup, events } = make();
    sup.register({ id: "agent", kind: "node", entry: CHILD, restart: "never" });
    await sup.start("agent");

    const st = sup.statusOf("agent")!;
    expect(st.state).toBe("alive");
    expect(isAlive(st.pid)).toBe(true);
    expect(await sup.rpc<ChildApi>("agent")!.health()).toEqual({ ok: true, detail: "agent" });
    // Every transition is on the bus: the process page is a projection, not a poller.
    expect(events.filter((e) => e.kind === EventKind.processStatus).length).toBeGreaterThan(1);
  });

  it("tracks heartbeats: current task and per-process spend", async () => {
    const { sup } = make();
    sup.register({
      id: "runner",
      kind: "node",
      entry: CHILD,
      restart: "never",
      heartbeatMs: 50,
      env: { HB_MS: "50" },
    });
    await sup.start("runner");
    const st = await until(() => {
      const s = sup.statusOf("runner");
      return s?.lastHeartbeat ? s : undefined;
    }, "first heartbeat");
    expect(st.currentTask).toMatch(/^task-/);
    expect(st.spend.tokens).toBeGreaterThan(0);
  });

  it("forwards child-emitted events onto the bus with process scope", async () => {
    const { sup, events } = make();
    sup.register({
      id: "emitter",
      kind: "node",
      entry: CHILD,
      restart: "never",
      env: { EMIT_ON_START: "1" },
    });
    await sup.start("emitter");
    const e = await until(
      () => events.find((x) => x.kind === EventKind.log && (x.payload as { stream?: string }).stream === "rpc"),
      "child event on the bus",
    );
    expect(e.scope.processId).toBe("emitter");
  });

  it("rejects a malformed event from a child and says so, instead of persisting it", async () => {
    const { sup, events } = make();
    sup.register({
      id: "sloppy",
      kind: "node",
      entry: CHILD,
      restart: "never",
      env: { EMIT_BAD: "1" },
    });
    await sup.start("sloppy");

    const rejected = await until(
      () => events.filter((e) => e.kind === EventKind.error).length >= 2 ? events.filter((e) => e.kind === EventKind.error) : undefined,
      "both malformed events rejected",
    );
    expect(rejected.every((e) => (e.payload as { code: string }).code === "WIRE_INVALID")).toBe(true);
    // …and nothing bogus made it onto the bus under its own name.
    expect(events.some((e) => e.kind === "")).toBe(false);
    expect(events.some((e) => e.scope.runId === (42 as unknown as string))).toBe(false);
  });

  it("captures child stdout as log events", async () => {
    const { sup, events } = make();
    sup.register({
      id: "noisy",
      kind: "exec",
      command: process.execPath,
      args: ["-e", "console.log('hello from exec'); setTimeout(()=>{}, 10_000)"],
      restart: "never",
    });
    await sup.start("noisy");
    const e = await until(
      () => events.find((x) => x.kind === EventKind.log && String((x.payload as { text: string }).text).includes("hello from exec")),
      "stdout captured",
    );
    expect(e.scope.processId).toBe("noisy");
  });

  it("does NOT restart a runner-style process — a pointless retry must surface", async () => {
    const { sup } = make();
    sup.register({
      id: "oneshot",
      kind: "node",
      entry: CHILD,
      restart: "never",
      env: { EXIT_AFTER_MS: "30", EXIT_CODE: "3" },
    });
    await sup.start("oneshot");
    const st = await until(
      () => (sup.statusOf("oneshot")!.state === "crashed" ? sup.statusOf("oneshot") : undefined),
      "crash observed",
    );
    expect(st.exitCode).toBe(3);
    expect(st.restarts).toBe(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(sup.statusOf("oneshot")!.state).toBe("crashed"); // still down
  });

  it("restarts an agent-style process and counts the restart", async () => {
    const { sup } = make();
    sup.register({
      id: "resilient",
      kind: "node",
      entry: CHILD,
      restart: "always",
      backoffMs: 1,
      env: { EXIT_AFTER_MS: "40" },
    });
    await sup.start("resilient");
    const st = await until(
      () => {
        const s = sup.statusOf("resilient")!;
        return s.restarts >= 1 && s.state === "alive" ? s : undefined;
      },
      "respawned and alive",
      8000,
    );
    expect(st.pid).toBeDefined();
  });

  it("kills a hung child: no heartbeat is treated exactly like a crash", async () => {
    const { sup } = make({ monitorMs: 30, missedBeats: 2 });
    sup.register({
      id: "hung",
      kind: "node",
      entry: CHILD,
      restart: "never",
      heartbeatMs: 40, // child is started without HB_MS, so it never beats
    });
    await sup.start("hung");
    const pid = sup.statusOf("hung")!.pid;
    const st = await until(
      () => (sup.statusOf("hung")!.state === "crashed" ? sup.statusOf("hung") : undefined),
      "hung child reaped",
    );
    expect(st.lastError).toMatch(/no heartbeat/);
    expect(isAlive(pid)).toBe(false);
  });

  /**
   * 两个方向都设了 `timeout: -1`（一次视觉判断几十秒、一次用例几分钟，60 秒的默认值会把
   * 健康的工作腰斩）。代价是：心跳只负责宣布对面死了并把它拉起来，它**不会**把已经发出去、
   * 再也等不到回复的调用结掉。于是 runner 崩在一次 execCase 中间，agent 的 await 永远不返回，
   * 整次运行永远停在 running。
   *
   * 用死讯，不用时限：慢是允许的，永远等下去不是。
   */
  it("对面死在一次调用中间时，这次调用会失败——而不是永远挂着", async () => {
    const { sup } = make({ monitorMs: 50, missedBeats: 100 });
    sup.register({ id: "agent", kind: "node", entry: CHILD, restart: "never" });
    await sup.start("agent");

    const call = (sup.rpc<ChildApi & { dieMidCall(): Promise<void> }>("agent") as never as {
      dieMidCall(): Promise<void>;
    }).dieMidCall();

    await expect(call).rejects.toThrow(/退出|不会有回复/);
  });

  it("对面已经死了之后再调，立刻失败而不是排队等一个不存在的回复", async () => {
    const { sup } = make({ monitorMs: 50, missedBeats: 100 });
    sup.register({ id: "agent", kind: "node", entry: CHILD, restart: "never" });
    await sup.start("agent");
    const rpc = sup.rpc<ChildApi>("agent")!;

    await sup.stop("agent");
    await expect(rpc.health()).rejects.toThrow(/退出|不会有回复/);
  });

  it("stop() drains cleanly and leaves no orphan", async () => {
    const { sup } = make();
    sup.register({ id: "quiet", kind: "node", entry: CHILD, restart: "always", backoffMs: 1 });
    await sup.start("quiet");
    const pid = sup.statusOf("quiet")!.pid;
    await sup.stop("quiet");
    expect(sup.statusOf("quiet")!.state).toBe("exited");
    await until(() => !isAlive(pid), "child process gone");
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.statusOf("quiet")!.state).toBe("exited"); // an intentional stop must not respawn
  });

  it("stops a process that is crash-looping, which is the one you most want to stop", async () => {
    // Found on a real instance: a capability whose port was already taken kept coming back
    // however many times it was stopped. During the backoff there is no child, and stop()
    // used to return early on exactly that — leaving the pending restart armed.
    const { sup } = make();
    sup.register({
      id: "looping",
      kind: "node",
      entry: CHILD,
      restart: "always",
      backoffMs: 400,
      env: { EXIT_AFTER_MS: "30" },
    });
    await sup.start("looping");
    await until(
      () => (sup.statusOf("looping")!.state === "restarting" ? true : undefined),
      "caught it inside the backoff",
      8000,
    );
    await sup.stop("looping");
    await new Promise((r) => setTimeout(r, 900)); // longer than the backoff
    expect(sup.statusOf("looping")!.state).toBe("idle");
    expect(sup.statusOf("looping")!.pid).toBeUndefined();
  });

  it("SIGKILLs a child that ignores shutdown", async () => {
    const { sup } = make();
    sup.register({
      id: "stubborn",
      kind: "node",
      entry: CHILD,
      restart: "never",
      graceMs: 100,
      env: { IGNORE_SHUTDOWN: "1" },
    });
    await sup.start("stubborn");
    const pid = sup.statusOf("stubborn")!.pid;
    await sup.stop("stubborn");
    await until(() => !isAlive(pid), "stubborn child reaped");
  });

  it("a SIGKILLed supervisor leaves no orphan — the child notices the dead IPC channel", async () => {
    const { spawn } = await import("node:child_process");
    const parent = spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/orphan-parent.mjs", import.meta.url))],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const childPid = await new Promise<number>((resolve) => {
      parent.stdout!.once("data", (b: Buffer) => resolve(JSON.parse(b.toString()).childPid));
    });
    expect(isAlive(childPid)).toBe(true);
    await until(() => !isAlive(childPid), "orphan reaped itself", 5000);
  });

  it("carries a rejected RPC back with its message — a lost error message is a lost diagnosis", async () => {
    const { sup } = make();
    sup.register({ id: "thrower", kind: "node", entry: CHILD, restart: "never" });
    await sup.start("thrower");
    const rpc = sup.rpc<ChildApi & { boom(): Promise<void> }>("thrower")!;
    await expect(rpc.boom()).rejects.toThrow(/kaboom: the child failed for a specific/);
  });

  it("lends a gate slot across the process boundary, and two children never overlap", async () => {
    const gate = new Gate(1);
    const lending = lendGate(gate);
    const events: Envelope[] = [];
    const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
    bus.subscribe((e) => events.push(e));
    sup = new Supervisor(bus, {
      extendParentApi: (id) => lending.api(id) as unknown as Record<string, (...a: never[]) => unknown>,
    });
    for (const id of ["r1", "r2"]) sup.register({ id, kind: "node", entry: CHILD, restart: "never" });
    await sup.startAll();

    type Leaser = { lease(holdMs: number): Promise<{ granted: number; holdEnd: number }> };
    const [a, b] = await Promise.all([
      sup.rpc<Leaser>("r1")!.lease(120),
      sup.rpc<Leaser>("r2")!.lease(120),
    ]);

    // Whoever went second must not have been granted until the first had finished holding.
    const [first, second] = a.granted <= b.granted ? [a, b] : [b, a];
    expect(second.granted).toBeGreaterThanOrEqual(first.holdEnd);
    expect(lending.outstanding()).toBe(0);
  });

  it("recovers the slot a killed child was holding", async () => {
    const gate = new Gate(1);
    const lending = lendGate(gate);
    const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
    // The gateway wires this to process.status; here it is called directly on the event.
    bus.subscribe((e) => {
      if (e.kind !== EventKind.processStatus) return;
      const s = e.payload as { id: string; state: string };
      if (s.state === "crashed" || s.state === "exited") lending.releaseAllFor(s.id);
    });
    sup = new Supervisor(bus, {
      extendParentApi: (id) => lending.api(id) as unknown as Record<string, (...a: never[]) => unknown>,
    });
    sup.register({ id: "holder", kind: "node", entry: CHILD, restart: "never" });
    await sup.start("holder");

    await sup.rpc<{ leaseAndHold(): Promise<number> }>("holder")!.leaseAndHold();
    expect(gate.stats().active).toBe(1);

    await sup.stop("holder");
    await until(() => lending.outstanding() === 0, "slot returned after the holder died");
    expect(gate.stats().active).toBe(0);
  });

  it("stopAll() takes everything down", async () => {
    const { sup } = make();
    sup.register({ id: "a", kind: "node", entry: CHILD, restart: "always", backoffMs: 1 });
    sup.register({ id: "b", kind: "node", entry: CHILD, restart: "always", backoffMs: 1 });
    await sup.startAll();
    const pids = sup.status().map((s) => s.pid!);
    await sup.stopAll();
    for (const pid of pids) await until(() => !isAlive(pid), `pid ${pid} gone`);
    expect(sup.status().every((s) => s.state === "exited")).toBe(true);
  });
});
