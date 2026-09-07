import { describe, expect, it } from "vitest";
import { CapabilityRecipeSchema } from "@testpilot/harness-core";

/**
 * 起草面给模型的 JSON Schema，和真正的校验器，必须认同一组 `kind`。
 *
 * 这条测试是为一个真实缺陷写的：schema 里漏掉了 `"app"`，而这个系统里最常见的一类
 * 能力正是 app（`harness.config.ts` 六个里四个）。**症状不是校验失败，是模型不会写**
 * ——约束解码只允许它在给定的取值里选，于是它被迫选一个错的。
 *
 * 一边加了取值而另一边忘了，是一个静默漂移（见 docs/refactor/18 的 A 类）。
 */
describe("chat capability schema", () => {
  it("offers the model exactly the kinds the validator accepts", async () => {
    const mod = await import("../src/chat.js");
    // SCHEMAS 不是导出的——从 checkRecipe 的对立面取：直接读源码里那一行的取值集，
    // 与 zod 的取值集比对。读源码而不是反射，是因为这条测试要盯的正是那段字面量。
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8"),
    );
    const m = /kind: \{ type: "string", enum: \[([^\]]+)\] \}/.exec(src);
    expect(m, "capability schema 里找不到 kind 的 enum —— 它被改名或删掉了").toBeTruthy();
    const inSchema = m![1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).sort();

    const shape = CapabilityRecipeSchema.shape.kind;
    const inValidator = [...(shape as unknown as { options: string[] }).options].sort();

    expect(inSchema).toEqual(inValidator);
    // 这个模块必须真的能被导入——上面那次 import 是为了让改名 chat.ts 的人也红一次。
    expect(typeof mod.checkRecipe).toBe("function");
  });

  it("accepts an app recipe, which is the most common kind in this repo", () => {
    const parsed = CapabilityRecipeSchema.safeParse({
      id: "bench-petclinic",
      kind: "app",
      command: "docker",
      args: ["run", "-p", "8080:8080", "example/petclinic:1.0"],
    });
    expect(parsed.success).toBe(true);
  });
});
