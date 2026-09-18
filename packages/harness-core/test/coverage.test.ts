import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { methodMix, scoreCoverage, type CandidateCase, type GoldChecklist } from "../src/eval/coverage.js";

const gold: GoldChecklist = {
  id: "test",
  items: [
    {
      id: "G-01",
      title: "valid login",
      designMethod: "equivalence",
      match: { anyOf: ["有效凭证", "valid credential"], assertAnyOf: ["面板", "dashboard"] },
    },
    {
      id: "G-03",
      title: "wrong password",
      designMethod: "negative",
      match: { anyOf: ["密码错误"], assertAnyOf: ["Invalid username or password"] },
    },
    {
      id: "G-08",
      title: "form cleared after logout",
      designMethod: "state-transition",
      heldOut: true,
      match: { assertAnyOf: ["为空", "清空"] },
    },
  ],
};

const kase = (title: string, expected: string, steps: string[] = []): CandidateCase => ({ title, steps, expected });

describe("scoreCoverage", () => {
  it("counts a gold item as covered only when the case is about it AND asserts it", () => {
    const r = scoreCoverage(gold, [
      kase("使用有效凭证登录", "跳转到个人面板并显示欢迎语"),
      // about the right thing, but asserts nothing relevant: mentioning is not covering
      kase("密码错误场景", "页面有反应"),
    ]);
    expect(r.hits.map((h) => h.goldId)).toEqual(["G-01"]);
    expect(r.misses.map((m) => m.id)).toEqual(["G-03", "G-08"]);
    expect(r.coverage).toBe(0.5); // 1 of 2 tuning items; the held-out one is scored apart
  });

  it("scores the held-out slice separately so a rising number cannot be fitted to it", () => {
    const r = scoreCoverage(gold, [kase("退出后检查表单", "用户名与密码输入框均为空")]);
    expect(r.coverage).toBe(0);
    expect(r.heldOut).toMatchObject({ coverage: 1, hits: ["G-08"], misses: [] });
    expect(r.totals).toEqual({ gold: 2, heldOut: 1, cases: 1 });
  });

  it("reports cases that match nothing — new ideas and out-of-scope inventions look alike here", () => {
    const r = scoreCoverage(gold, [kase("使用微信扫码登录", "登录成功")]);
    expect(r.extras.map((c) => c.title)).toEqual(["使用微信扫码登录"]);
  });

  it("lets one case cover several items and one item be covered by several cases", () => {
    const r = scoreCoverage(gold, [
      kase("有效凭证登录", "显示 dashboard"),
      kase("valid credential login again", "面板出现"),
    ]);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].by).toHaveLength(2);
    expect(r.extras).toHaveLength(0);
  });

  it("matches on the steps too, not just the title", () => {
    const r = scoreCoverage(gold, [kase("场景一", "跳转到个人面板", ["输入有效凭证", "点击 Sign in"])]);
    expect(r.hits.map((h) => h.goldId)).toEqual(["G-01"]);
  });

  it("is case-insensitive and tolerant of whitespace", () => {
    const r = scoreCoverage(gold, [kase("密码错误  重试", "提示  Invalid   Username or Password")]);
    expect(r.hits.map((h) => h.goldId)).toEqual(["G-03"]);
  });

  it("reports zero coverage for an empty suite instead of dividing by nothing", () => {
    const r = scoreCoverage(gold, []);
    expect(r.coverage).toBe(0);
    expect(r.heldOut.coverage).toBe(0);
    expect(r.misses).toHaveLength(3);
  });

  it("breaks coverage down by design method — an all-happy-path suite must look bad here", () => {
    const r = scoreCoverage(gold, [kase("有效凭证登录", "显示 dashboard")]);
    expect(methodMix(gold, r)).toEqual({
      equivalence: { expected: 1, covered: 1 },
      negative: { expected: 1, covered: 0 },
      "state-transition": { expected: 1, covered: 0 },
    });
  });
});

describe("the shipped gold checklist", () => {
  const shipped = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../fixtures/sample-spec/gold-checklist.json", import.meta.url)), "utf8"),
  ) as GoldChecklist;

  it("is well formed and keeps a held-out slice", () => {
    expect(shipped.items.length).toBeGreaterThanOrEqual(10);
    expect(shipped.items.every((i) => i.id && i.title && i.match)).toBe(true);
    expect(shipped.items.filter((i) => i.heldOut).length).toBeGreaterThanOrEqual(3);
  });

  it("covers all four design methods the spec calls for", () => {
    const methods = new Set(shipped.items.map((i) => i.designMethod));
    expect([...methods].sort()).toEqual(["boundary", "equivalence", "negative", "state-transition"]);
  });

  it("scores a plausible suite the way a reviewer would", () => {
    const suite: CandidateCase[] = [
      kase("使用有效凭证成功登录", "跳转到个人面板，显示 Welcome 与用户名"),
      kase("密码错误登录被拒绝", "显示 Invalid username or password，停留在登录页"),
      kase("空用户名登录", "显示 Invalid username or password"),
      kase("空密码登录", "显示 Invalid username or password"),
      kase("退出登录", "回到登录表单，sign in 表单重新显示"),
    ];
    const r = scoreCoverage(shipped, suite);
    // A reasonable-but-incomplete suite lands in the middle: the point of the number is
    // that it moves, not that a first attempt scores well.
    expect(r.coverage).toBeGreaterThan(0.4);
    expect(r.coverage).toBeLessThan(1);
    expect(r.misses.map((m) => m.id)).toContain("G-12"); // nobody wrote the long-input case
  });
});
