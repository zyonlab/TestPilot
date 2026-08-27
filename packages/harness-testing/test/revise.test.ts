import { describe, expect, it } from "vitest";
import { FakeModel } from "@testpilot/harness-core";
import { reviseCase } from "../src/casegen/revise.js";
import type { TextCase } from "../src/casegen/types.js";

/**
 * Regenerating one case from the review queue. What matters is that the objections reach
 * the model verbatim and that the revised case is still the same case — same id, same
 * story — because a reviewer is mid-decision about that one.
 */

const kase: TextCase = {
  id: "US-01-2-empty-user",
  storyId: "US-01",
  title: "用户名为空时登录被拒绝",
  designMethod: "negative",
  precondition: ["已打开登录页"],
  steps: ["用户名留空", "输入密码 hunter2", "点击登录"],
  expected: "登录失败，行为正常",
  tier: 3,
  key: "login|empty-user|rejected",
};

const revised = {
  cases: [
    {
      title: "用户名为空时登录被拒绝",
      designMethod: "negative",
      precondition: ["已打开登录页"],
      steps: ["用户名留空", "输入密码 ${secret.LOGIN_PASSWORD}", "点击登录"],
      expected: '页面显示「用户名不能为空」，且仍停留在登录页',
      tier: 1,
      key: "login|empty-user|rejected",
    },
  ],
};

describe("regenerating a case a reviewer objected to", () => {
  it("hands the objections over verbatim and keeps the case's identity", async () => {
    const model = new FakeModel(() => JSON.stringify(revised), { tokens: 320 });
    const out = await reviseCase(model, {
      kase,
      objections: [
        '[oracle-vague] assertion promises nothing checkable: "登录失败，行为正常"',
        "[secret] credential written into a step instead of a placeholder",
      ],
      story: { id: "US-01", title: "登录", acceptance: ["空用户名必须被拒绝"] },
      specText: "登录模块规格",
      lang: "zh",
    });

    const sent = model.calls[0]!;
    expect(sent.variable).toContain("oracle-vague");
    expect(sent.variable).toContain("credential written into a step");
    // The existing case travels with it: "fix this" is not answerable without it.
    expect(sent.variable).toContain("登录失败，行为正常");
    // The stable half must not carry the case, or every revision misses the prefix cache.
    expect(sent.stable).not.toContain("登录失败，行为正常");

    expect(out.kase.id).toBe(kase.id);
    expect(out.kase.storyId).toBe("US-01");
    expect(out.kase.tier).toBe(1);
    expect(out.kase.expected).toContain("用户名不能为空");
    expect(out.kase.steps.join(" ")).toContain("${secret.LOGIN_PASSWORD}");
    expect(out.tokens).toBe(320);
  });

  it("says the reply was cut off rather than blaming its formatting", async () => {
    const model = new FakeModel('{"cases":[{"title":"a","steps":["b"');
    // FakeModel reports no truncation flag, so this is the plain malformed path; the
    // budget-aware message is covered where the flag exists (casegen).
    await expect(reviseCase(model, { kase, objections: [] })).rejects.toThrow(/revise:US-01-2-empty-user/);
  });
});
