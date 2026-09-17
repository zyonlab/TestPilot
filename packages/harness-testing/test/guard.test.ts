import { describe, expect, it } from "vitest";
import { checkRun } from "../src/guard.js";

/**
 * 2026-09-16 起不可逆步骤**默认放行**：删除、完成、清理是被测产品的功能，用例要测的就是它们。
 * 全局只有禁止名单；运营方要拦回来是 `blockIrreversible`（整机开关，不是每个环境勾一次）。
 * 行业特有的副作用词跟着那个产品的规则包走（`sideEffectLabels`），通用表里不放。
 */
const guard = { denyHosts: ["prod.example.com"], blockIrreversible: true };
const relaxed = { denyHosts: ["prod.example.com"], blockIrreversible: false };

describe("guard", () => {
  it("默认放行：删除自己刚建的东西正是用例要做的事", () => {
    expect(checkRun("http://localhost:5301/app", ["删除当前账号", "确认删除"], relaxed).allow).toBe(true);
  });

  it("allows ordinary steps anywhere: it is not a lockdown", () => {
    expect(checkRun("https://shop.example.com", ["搜索 T 恤", "加入购物车"], guard).allow).toBe(true);
  });

  it("环境没有允许时拦下不可逆步骤，并说清楚", () => {
    const v = checkRun("https://shop.example.com", ["登录", "删除收货地址"], guard);
    expect(v.allow).toBe(false);
    expect(v.code).toBe("GUARD_IRREVERSIBLE");
    expect(v.why).toContain("删除收货地址");
    expect(v.why).toContain("shop.example.com");
  });

  it("catches it in a teardown step too — cleanup is where the deletes live", () => {
    expect(checkRun("https://shop.example.com", ["浏览订单", "checkout with the saved card"], guard).allow).toBe(false);
  });

  it("禁止名单上的地址什么都不跑——环境怎么勾都没用", () => {
    const v = checkRun("https://prod.example.com", ["查看首页"], relaxed);
    expect(v.allow).toBe(false);
    expect(v.code).toBe("GUARD_HOST");
  });

  it("can be switched off entirely", () => {
    expect(checkRun("https://shop.example.com", ["删除账号"], { ...guard, blockIrreversible: false }).allow).toBe(true);
  });
});

describe("行业副作用词来自规则包，不来自代码", () => {
  const steps = ["全量平仓并等待成交", "撤掉其中一笔挂单", "以 Reduce Only 提交开仓方向的订单"];

  it("没有规则包的词时，通用表不认交易动词——换个产品它们什么都不是", () => {
    for (const step of steps) expect(checkRun("https://trade.example.test/", [step], guard).allow).toBe(true);
  });

  it("规则包声明了就拦", () => {
    const labels = ["平仓", "撤掉", "开仓"];
    for (const step of steps) {
      const v = checkRun("https://trade.example.test/", [step], guard, { sideEffectLabels: labels });
      expect(v.allow).toBe(false);
      expect(v.code).toBe("GUARD_IRREVERSIBLE");
    }
  });

  it("通用的动钱动作不需要规则包：授权、转账、提现", () => {
    for (const step of ["连接钱包并完成授权", "向另一个账户转账", "提现到银行卡"])
      expect(checkRun("https://any.example.test/", [step], guard).allow).toBe(false);
  });
});

it("规则包的副作用条目按正则解释：动作要拦，名词别误伤", () => {
  const labels = ["下单(?!面板|区|表单|页|入口|状态)", "开仓(?!价)"];
  expect(checkRun("https://trade.example.test/", ["点击下单按钮提交"], guard, { sideEffectLabels: labels }).allow).toBe(false);
  expect(checkRun("https://trade.example.test/", ["查看下单面板", "读取该行的开仓价"], guard, { sideEffectLabels: labels }).allow).toBe(true);
  // 写坏的正则跳过，不让守卫整条炸掉。
  expect(checkRun("https://trade.example.test/", ["删除账号"], guard, { sideEffectLabels: ["(unclosed"] }).code).toBe("GUARD_IRREVERSIBLE");
});
