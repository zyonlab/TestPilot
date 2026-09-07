import { describe, it, expect } from "vitest";
import { FakeModel } from "@testpilot/harness-core";
import { fillGap } from "../src/casegen/fillgap.js";

const REPLY = JSON.stringify({
  cases: [
    {
      title: "从 /owners 进入查找页",
      designMethod: "equivalence",
      tier: 1,
      precondition: [],
      steps: ["点击「Find owners」"],
      expected: "地址进入 /owners/find",
      postSteps: [],
    },
  ],
});

describe("U-61 · 缺口补成用例", () => {
  it("missed 那一类照着证据补，并且把覆盖的那条转移填上", async () => {
    const out = await fillGap(new FakeModel(REPLY), {
      gap: {
        kind: "transition",
        reach: "missed",
        what: "这条路走过，没有用例验它",
        anchor: { kind: "edge", from: "/owners", to: "/owners/find" },
      },
      storyId: "S-01",
    });
    // 不填 covers 的话，补回来的用例在结构覆盖率上仍然是零——
    // 那正是它被补出来要解决的问题。
    expect(out.kase.covers).toEqual(["/owners->/owners/find"]);
    expect(out.kase.storyId).toBe("S-01");
    expect(out.kase.id.startsWith("GAP-")).toBe(true);
  });

  it("blind 那一类不补——对着没人见过的界面写的用例，绿色说明不了任何事", async () => {
    await expect(
      fillGap(new FakeModel(REPLY), {
        gap: { kind: "blocked", reach: "blind", what: "登录挡住了，这一片没看见过" },
      }),
    ).rejects.toThrow(/说明不了/);
  });

  it("id 是稳定的：同一条缺口补两次得到同一个 id", async () => {
    const gap = { kind: "transition" as const, reach: "unseen" as const, what: "看见过入口，从没进去" };
    const a = await fillGap(new FakeModel(REPLY), { gap });
    const b = await fillGap(new FakeModel(REPLY), { gap });
    expect(a.kase.id).toBe(b.kase.id);
  });

  it("unseen 没有 anchor 时不硬填 covers——填一个编出来的转移比不填更糟", async () => {
    const out = await fillGap(new FakeModel(REPLY), {
      gap: { kind: "transition", reach: "unseen", what: "看见过入口，从没进去" },
    });
    // schema 给 covers 的默认值是空数组——空就是「它没说自己覆盖了哪条转移」，
    // 而那正是没有 anchor 时唯一诚实的答案。
    expect(out.kase.covers ?? []).toEqual([]);
  });
});
