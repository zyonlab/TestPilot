#!/usr/bin/env tsx
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 生成一个新节点的骨架。
 *
 * 加一个节点是这套 harness 里最贵的一件小事：一个节点是一段 TypeScript，带 schema、
 * 带 in/out kind、要注册、要写测试。这不是模板能消掉的成本——**编排由代码决定是有意的
 * 设计**，一条每次都不一样地启动的流水线没法和自己比较，而"能和自己比较"是评测层存在的
 * 全部理由。要的是词汇量（能表达更多种步骤），不是语法自由（每次结构都不同）。
 *
 * 但样板不该每次重写。`source.codebase` 至今没建，想清楚的部分早就想清楚了，卡住的是
 * 从零敲出这堆结构。这个脚本只做那一件事：把结构给出来，连同**那些必须由人回答的问题**
 * ——以 TODO 的形式留在文件里，而不是替他填一个看起来合理的默认值。
 *
 *   pnpm --filter @testpilot/harness-testing new:node source.codebase
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const type = process.argv[2];
if (!type || !/^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(type)) {
  console.error("用法：new:node <group.name>，例如 source.codebase");
  console.error("节点类型是 `组.名字`：组说明它属于流水线的哪一段，名字说明它做什么。");
  process.exit(1);
}

const [group, name] = type.split(".");
const fn = `${name}${group[0].toUpperCase()}${group.slice(1)}Node`;
const file = resolve(ROOT, "src", group === "source" || group === "spec" || group === "plan" || group === "design"
  ? "casegen"
  : "codegen", `${name}.node.ts`);
const testFile = resolve(ROOT, "test", `${name}.node.test.ts`);

if (existsSync(file)) {
  console.error(`已经有了：${file}`);
  process.exit(1);
}

const node = `import { z } from "zod";
import type { NodeDef } from "@testpilot/harness-core";
import type { CaseGenNodeOptions } from "./nodes.js";
import { KIND } from "./types.js";

/**
 * TODO 一句话说清这一步做什么，以及**它为什么是单独一步**。
 *
 * 一个说不出自己为什么不能并进上一步的节点，多半就该并进去：图上的每一个方框都是一处
 * 断点、一份缓存、一个人要理解的东西。
 */
export function ${fn}(opts: CaseGenNodeOptions): NodeDef<
  z.infer<typeof PARAMS>,
  z.infer<typeof INPUT>,
  z.infer<typeof OUTPUT>
> {
  return {
    type: "${type}",
    title: "TODO 界面上显示的名字",
    description: "TODO 一句话，会显示在调色板里",

    /**
     * 类型决定这一步能接在谁后面。
     *
     * TODO 从 \`KIND\` 里选，或者加一个新的。**加新 kind 之前先确认它真的是一种新东西**：
     * 两种 kind 长得一样时，图上就会出现两条永远接不到一起的线。
     */
    inKind: KIND.material,
    outKind: KIND.spec,

    params: PARAMS,
    input: INPUT,
    output: OUTPUT,

    run: async (input, params, ctx) => {
      // TODO 这一步要不要调模型？
      //
      // 不调是更好的默认：确定性的一步不会在两次运行之间飘，而"两次运行可比"是这个项目
      // 的地基。真要调，就把花费记上——没有记花费的模型调用，会让预算和评测同时失真：
      //
      //   const res = await opts.model.chat({ stable: STABLE, variable, maxTokens, label: "${type}" });
      //   ctx.spend({ calls: 1, tokens: res.tokens });
      //
      // TODO 产出为空时要抛错，不要返回一个空壳。一个"成功了但什么也没产出"的节点，
      // 会让下游在离原因很远的地方失败。
      void input;
      void params;
      void ctx;
      throw new Error("${type}: 还没实现");
    },
  };
}

const PARAMS = z.object({
  // TODO 参数要有默认值，且默认值本身要是一个可辩护的选择——它会被大多数运行沿用。
});

const INPUT = z.unknown();

const OUTPUT = z.object({
  // TODO 产物的形状。下游读的是它，人也读的是它。
});
`;

const test = `import { describe, expect, it } from "vitest";
import { FakeModel } from "@testpilot/harness-core";
import { ${fn} } from "../src/${group === "source" || group === "spec" || group === "plan" || group === "design" ? "casegen" : "codegen"}/${name}.node.js";

/**
 * TODO 这个文件守的是什么。
 *
 * 不是"覆盖率"——是**这一步一旦坏掉，会以什么形式骗到人**。这套代码里最有价值的测试
 * 全是这种：门禁误伤了它最该放行的用例、出处是模型自己声称的、少报花费的报告。
 */

const ctx = (logs: Array<Record<string, unknown>> = []) =>
  ({
    nodeId: "n",
    ablated: new Set(),
    spend: () => {},
    emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
  }) as never;

describe("${type}", () => {
  it("TODO 正常情况下产出什么", async () => {
    const node = ${fn}({ model: new FakeModel(() => "{}") });
    await expect(node.run({} as never, {} as never, ctx())).rejects.toThrow();
  });

  it("TODO 产出为空时抛错，而不是返回一个空壳", async () => {
    expect(true).toBe(true);
  });
});
`;

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, node);
writeFileSync(testFile, test);

console.log(`已生成：
  ${file}
  ${testFile}

还差三步，脚本不替你做——它们都需要一个决定：
  1. 在 casegen/nodes.ts 或 codegen/nodes.ts 的节点数组里注册 ${fn}(opts)
  2. 如果它引入了新的产物类型，在 casegen/types.ts 的 KIND 里加一条，并说明它和已有的哪些不同
  3. 把它接进 pack.ts 的某张图 —— 一个不在任何图里的节点，调色板上有，但没人跑得到`);
