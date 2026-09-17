import { describe, expect, it } from "vitest";
import { missingPlaceholders } from "../src/workflowExecution.js";

/**
 * 2026-09-16：用例引用 `${env.BASE_URL}`，环境里只有 `USERNAME`——认不出的键被原样留着送进浏览器，
 * 「打开 ${env.BASE_URL}/login」被规划成一个不存在的 Navigate 动作，而另一条把字面量当密码填了进去
 * （它恰好是个错密码，于是那条用例的真实判决被掩盖）。缺什么要在跑之前说出来。
 */
describe("执行前的占位符检查", () => {
  const context = { env: { BASE_URL: "http://localhost:3456" }, secrets: { PASSWORD: "x" } };

  it("环境与密钥都齐了就没有缺口", () => {
    expect(missingPlaceholders(["打开 ${env.BASE_URL}/login", "填入 ${secret.PASSWORD}"], context)).toEqual([]);
  });

  it("缺的键逐个点名，环境变量与密钥分开说", () => {
    expect(missingPlaceholders(["打开 ${env.BASE_URL}/login", "填入 ${env.USERNAME}", "填入 ${secret.VIKUNJA_PASSWORD}"], context))
      .toEqual(["env.USERNAME", "secret.VIKUNJA_PASSWORD"]);
  });

  it("同一个键在多条步骤里只报一次；`${row}` 这类数据占位符不算缺", () => {
    expect(missingPlaceholders(["${env.A}", "又一次 ${env.A}", "${row.name}", "${row}"], context)).toEqual(["env.A"]);
  });
});
