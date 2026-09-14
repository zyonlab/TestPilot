import { describe, expect, it } from "vitest";
import { Gate } from "../src/model/gate.js";
import { lendGate } from "../src/model/lending.js";
import { setModelLease, withModel } from "../src/model/lease.js";

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("Gate", () => {
  it("admits one at a time and hands the slot to the next in line", async () => {
    const gate = new Gate(1);
    const order: number[] = [];
    const blockers = [defer(), defer(), defer()];

    const runs = blockers.map((b, i) =>
      gate.run(async () => {
        order.push(i);
        await b.promise;
      }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0]); // the other two are queued, not running
    expect(gate.stats()).toEqual({ limit: 1, active: 1, waiting: 2 });

    blockers[0].resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0, 1]); // FIFO

    blockers[1].resolve();
    blockers[2].resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
    expect(gate.stats()).toEqual({ limit: 1, active: 0, waiting: 0 });
  });

  it("releases the slot when the call throws — one failure must not wedge the queue", async () => {
    const gate = new Gate(1);
    await expect(gate.run(async () => {
      throw new Error("model 502");
    })).rejects.toThrow("model 502");
    expect(gate.stats().active).toBe(0);
    expect(await gate.run(async () => "next call gets in")).toBe("next call gets in");
  });

  it("ignores a double release instead of over-admitting", async () => {
    const gate = new Gate(1);
    const release = await gate.acquire();
    release();
    release();
    expect(gate.stats()).toEqual({ limit: 1, active: 0, waiting: 0 });
  });

  it("honours a limit above one", async () => {
    const gate = new Gate(2);
    const b = [defer(), defer(), defer()];
    void b.map((d) => gate.run(() => d.promise));
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.stats()).toMatchObject({ active: 2, waiting: 1 });
    b.forEach((d) => d.resolve());
  });
});

describe("model lease", () => {
  it("is a pass-through until a process binds one", async () => {
    expect(await withModel(async () => "unbound")).toBe("unbound");
  });

  it("routes every model call through whatever the process bound", async () => {
    const gate = new Gate(1);
    let seen = 0;
    setModelLease((fn) => {
      seen += 1;
      return gate.run(fn);
    });
    expect(await withModel(async () => "gated")).toBe("gated");
    expect(seen).toBe(1);
    setModelLease((fn) => fn()); // restore for the other tests in this file
  });
});

describe("lending slots to other processes", () => {
  it("hands out tickets and takes the slot back on release", async () => {
    const gate = new Gate(1);
    const lending = lendGate(gate);
    const runner = lending.api("runner-1");

    const t1 = await runner.acquireModel();
    expect(gate.stats()).toMatchObject({ active: 1, waiting: 0 });
    expect(lending.outstanding()).toBe(1);

    let second: number | undefined;
    const pending = runner.acquireModel().then((t) => (second = t));
    await new Promise((r) => setTimeout(r, 10));
    expect(second).toBeUndefined(); // still queued behind the first ticket

    await runner.releaseModel(t1);
    await pending;
    expect(second).toBe(2);
    expect(lending.outstanding()).toBe(1);
  });

  it("releases what a dead process held — a lost slot would stall every later call", async () => {
    const gate = new Gate(1);
    const lending = lendGate(gate);
    await lending.api("runner-1").acquireModel(); // …and then the process crashes

    let granted = false;
    const queued = lending.api("runner-2").acquireModel().then(() => (granted = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(granted).toBe(false);

    expect(lending.releaseAllFor("runner-1")).toBe(1);
    await queued;
    expect(granted).toBe(true);
  });

  it("ignores a release for a ticket that is not outstanding", async () => {
    const lending = lendGate(new Gate(1));
    await expect(lending.api("runner-1").releaseModel(999)).resolves.toBeUndefined();
    expect(lending.outstanding()).toBe(0);
  });
});
