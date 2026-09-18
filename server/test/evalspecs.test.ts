import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listEvalSpecs, REPO_ROOT } from "../src/evalspecs.js";

/**
 * 评测集是仓库里的文件，所以它的校验也要在仓库这一侧。
 *
 * 这里守的不是格式，是三条会让一份评测悄悄失去意义的错误：接不上的消融开关（报告会说
 * 「关掉它没有影响」，而那句话说的是开关没接上，不是组件不重要）、两组配置完全相同
 * （量到的只有噪声，但看起来和一个真实结论一模一样）、以及一份读不出来的定义被静默跳过
 * （评测集悄悄变小，界面上一切正常）。
 */

const dir = resolve(REPO_ROOT, "evals");
const scratch: string[] = [];

const write = (name: string, body: unknown) => {
  const p = resolve(dir, name);
  writeFileSync(p, JSON.stringify(body, null, 2));
  scratch.push(p);
};

const base = (over: Record<string, unknown> = {}) => ({
  id: "zz-scratch",
  title: "t",
  why: "十个字以上的理由，说明这次为什么要问这个问题",
  graphId: "g1-text-cases",
  a: { label: "现状", ablate: [] },
  b: { label: "改动后", ablate: ["dedupe"] },
  ...over,
});

beforeEach(() => mkdirSync(dir, { recursive: true }));
afterEach(() => {
  for (const p of scratch.splice(0)) rmSync(p, { force: true });
});

const find = (id: string) => listEvalSpecs().specs.find((s) => s.id === id);
const problem = (name: string) =>
  listEvalSpecs().problems.find((p) => p.path === `evals/${name}`)?.error ?? "";

describe("仓库里的评测定义", () => {
  it("仓库自带的那几份全部读得出来", () => {
    const { specs, problems } = listEvalSpecs();
    expect(problems).toEqual([]);
    expect(specs.map((s) => s.id)).toContain("domain-perp");
    expect(specs.every((s) => s.why.length >= 10)).toBe(true);
  });

  it("读得出一份合规的定义，并记下它来自哪个文件", () => {
    write("zz-scratch.json", base());
    expect(find("zz-scratch")?.path).toBe("evals/zz-scratch.json");
  });

  it("拒绝没有节点在读的消融开关", () => {
    write("zz-scratch.json", base({ b: { label: "改动后", ablate: ["no-such-switch"] } }));
    expect(problem("zz-scratch.json")).toContain("未知的消融开关");
  });

  it("拒绝两组完全一样的配对——那样量到的只有噪声", () => {
    write("zz-scratch.json", base({ a: { label: "甲", ablate: [] }, b: { label: "乙", ablate: [] } }));
    expect(problem("zz-scratch.json")).toContain("配置完全相同");
  });

  it("拒绝说不出为什么要问的评测", () => {
    write("zz-scratch.json", base({ why: "改了下" }));
    expect(problem("zz-scratch.json")).toContain("why");
  });

  it("id 和文件名对不上要报出来——引用它的地方会对不上", () => {
    write("zz-scratch.json", base({ id: "另一个名字" }));
    expect(problem("zz-scratch.json")).toContain("必须一致");
  });

  it("坏文件被报出来而不是静默跳过，好文件照常读出来", () => {
    writeFileSync(resolve(dir, "zz-broken.json"), "{ 这不是 json");
    scratch.push(resolve(dir, "zz-broken.json"));
    write("zz-scratch.json", base());
    expect(find("zz-scratch")).toBeTruthy();
    expect(problem("zz-broken.json")).toBeTruthy();
  });

  it("只认 expect.direction 的四个取值——unknown 也是其中之一", () => {
    write("zz-scratch.json", base({ expect: { direction: "会更好", note: "" } }));
    expect(problem("zz-scratch.json")).toContain("expect.direction");
    write("zz-scratch.json", base({ expect: { direction: "unknown", note: "说不好" } }));
    expect(find("zz-scratch")?.expect?.direction).toBe("unknown");
  });
});
