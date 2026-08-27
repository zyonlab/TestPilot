import { describe, expect, it } from "vitest";
import { checkRun } from "../src/guard.js";

const guard = {
  allowHosts: ["localhost", "127.0.0.1"],
  blockIrreversible: true,
  allowlistOnly: false,
};

describe("guard", () => {
  it("lets anything through on an allowlisted host — that is what a test environment is for", () => {
    const v = checkRun("http://localhost:5301/app", ["删除当前账号", "确认删除"], guard);
    expect(v.allow).toBe(true);
  });

  it("allows ordinary steps anywhere: it is not a lockdown", () => {
    expect(checkRun("https://shop.example.com", ["搜索 T 恤", "加入购物车"], guard).allow).toBe(true);
  });

  it("blocks an irreversible step on a host nobody allowlisted", () => {
    const v = checkRun("https://shop.example.com", ["登录", "删除收货地址"], guard);
    expect(v.allow).toBe(false);
    expect(v.code).toBe("GUARD_IRREVERSIBLE");
    expect(v.why).toContain("删除收货地址");
  });

  it("catches it in a teardown step too — cleanup is where the deletes live", () => {
    const v = checkRun("https://shop.example.com", ["浏览订单", "checkout with the saved card"], guard);
    expect(v.allow).toBe(false);
  });

  it("can refuse unknown hosts outright when a team opts in", () => {
    const v = checkRun("https://prod.example.com", ["查看首页"], { ...guard, allowlistOnly: true });
    expect(v.allow).toBe(false);
    expect(v.code).toBe("GUARD_HOST");
  });

  it("can be switched off entirely", () => {
    const v = checkRun("https://prod.example.com", ["删除账号"], { ...guard, blockIrreversible: false });
    expect(v.allow).toBe(true);
  });

  it("explains itself — a refusal without a reason just gets disabled", () => {
    const v = checkRun("https://shop.example.com", ["退款该订单"], guard);
    expect(v.why).toMatch(/irreversible/);
    expect(v.why).toContain("shop.example.com");
  });
});
