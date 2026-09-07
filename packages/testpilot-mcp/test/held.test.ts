import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Held, HeldResultSchema, heldResult } from "../src/contracts.js";
import { readMeta } from "../src/runs.js";

/**
 * 三态里的第三态。被门禁拦下不是错误：读的人要能把「工具坏了」和「规则拦了」分开数。
 */
describe("blocked：被门禁拦下的工具结果", () => {
  it("没有 meta.json 的运行被 binding 门拦下，不是一个普通异常", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-held-"));
    let caught: unknown;
    try {
      readMeta(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Held);
    expect((caught as Held).gate).toBe("binding");
  });

  it("印记缺项同样是 binding 门，理由点名缺的字段", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-held-"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: "r", stage: "g1" }));
    let caught: unknown;
    try {
      readMeta(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Held);
    expect((caught as Held).message).toMatch(/skillVersion/);
  });

  it("回给调用方的形状：status=blocked + gate + reason，且不是 isError", () => {
    const value = heldResult(new Held("lineage", "different checklist"));
    expect(HeldResultSchema.parse(value)).toEqual({ status: "blocked", gate: "lineage", reason: "different checklist" });
  });

  it("一个不在名单上的门建不出来（类型层）——名单与 hook 的 output.gate 用同一套词", () => {
    expect(HeldResultSchema.safeParse({ status: "blocked", gate: "whatever", reason: "x" }).success).toBe(false);
  });
});
