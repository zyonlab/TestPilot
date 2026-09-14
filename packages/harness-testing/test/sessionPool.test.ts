import { describe, it, expect } from "vitest";
import { acquireSession, releaseSession, evictSession, pooledSessionKeys, replaceSession } from "../src/exec/sessionPool.js";

/** 会话池不认识浏览器，这里用计数器当会话：建了几次、关了几次一目了然。 */
const mk = () => {
  let created = 0;
  const closed: number[] = [];
  return {
    create: async () => ({ id: ++created }),
    close: async (s: { id: number }) => { closed.push(s.id); },
    get created() { return created; },
    closed,
  };
};

describe("会话池（T-28）", () => {
  it("同 key 同指纹：第二次复用，不再创建", async () => {
    const f = mk();
    const a = await acquireSession("b1", "fp", f.create, f.close);
    const b = await acquireSession("b1", "fp", f.create, f.close);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(true);
    expect(b.session).toBe(a.session);
    expect(f.created).toBe(1);
    expect(b.uses).toBe(2);
    await releaseSession("b1");
  });

  it("同 key 换指纹：旧的关掉、新的建起来，池里只有一个", async () => {
    const f = mk();
    const a = await acquireSession("b2", "fp-A", f.create, f.close);
    const b = await acquireSession("b2", "fp-B", f.create, f.close);
    expect(b.reused).toBe(false);
    expect(f.closed).toEqual([a.session.id]);
    expect(f.created).toBe(2);
    expect(pooledSessionKeys().filter((k) => k === "b2")).toHaveLength(1);
    await releaseSession("b2");
  });

  it("release 关掉并移出；再 release 返回 false，不是报错", async () => {
    const f = mk();
    await acquireSession("b3", "fp", f.create, f.close);
    expect(await releaseSession("b3")).toBe(true);
    expect(f.closed).toHaveLength(1);
    expect(await releaseSession("b3")).toBe(false);
    expect(pooledSessionKeys()).not.toContain("b3");
  });

  it("evict 之后下一次 acquire 是新会话——坏掉的浏览器不会被下一条接着用", async () => {
    const f = mk();
    const a = await acquireSession("b4", "fp", f.create, f.close);
    await evictSession("b4");
    const b = await acquireSession("b4", "fp", f.create, f.close);
    expect(b.reused).toBe(false);
    expect(b.session).not.toBe(a.session);
    await releaseSession("b4");
  });

  it("不同 key 互不影响", async () => {
    const f = mk();
    await acquireSession("x", "fp", f.create, f.close);
    await acquireSession("y", "fp", f.create, f.close);
    expect(f.created).toBe(2);
    await releaseSession("x");
    expect(pooledSessionKeys()).toContain("y");
    await releaseSession("y");
  });

  it("replace 之后下一次复用拿到的是新对象，关掉时关的也是新对象", async () => {
    const f = mk();
    await acquireSession("b5", "fp", f.create, f.close);
    replaceSession("b5", { id: 99 });
    const b = await acquireSession("b5", "fp", f.create, f.close);
    expect(b.reused).toBe(true);
    expect(b.session).toEqual({ id: 99 });
    await releaseSession("b5");
    expect(f.closed).toEqual([99]);
  });
});
