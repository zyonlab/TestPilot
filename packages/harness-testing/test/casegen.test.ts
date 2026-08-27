import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeModel } from "@testpilot/harness-core";
import { designCasesNode, parseJson, planStoriesNode } from "../src/casegen/nodes.js";

/**
 * A model reply that stops mid-array is indistinguishable from a badly formatted one once
 * it reaches JSON.parse. The server tells us which happened; these keep that answer from
 * being thrown away, because the two have opposite fixes.
 */


describe("a reply that ran out of room", () => {
  it("blames the budget rather than the model's formatting", () => {
    const truncated = '{"stories":[{"id":"US-01","title":"a","acceptance":["x"]},{"id":"US-02"';
    expect(() =>
      parseJson(truncated, z.object({ stories: z.array(z.unknown()) }), "plan.stories", {
        truncated: true,
        maxTokens: 1200,
      }),
    ).toThrow(/cut off at maxTokens \(1200\).*budget problem/s);
  });

  it("stays quiet about the budget when the reply was simply malformed", () => {
    expect(() => parseJson("{oops}", z.object({ a: z.string() }), "plan.stories")).toThrow(
      /not valid JSON —/,
    );
  });
});

describe("a specification that is several documents", () => {
  const twoDocs = [
    "===== docs/a.md =====\n业务：US-01 新建项目",
    "===== docs/b.md =====\n界面：进程页列出各进程状态",
  ].join("\n\n");

  const runStories = async (reply: unknown, origin: string) => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({ model: new FakeModel(() => JSON.stringify(reply)) });
    const out = await node.run(
      { text: twoDocs, origin, title: "", rules: [], unknowns: [] },
      { maxStories: 12 },
      {
        nodeId: "stories",
        ablated: new Set(),
        spend: () => {},
        emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
      } as never,
    );
    return { out, logs };
  };

  it("names the document a story came from", async () => {
    const { out } = await runStories(
      { stories: [{ id: "US-01", title: "新建项目", acceptance: [], source: "docs/a.md" }] },
      "docs/a.md",
    );
    expect(out.stories[0].source).toBe("docs/a.md");
  });

  it("says out loud when a document produced no story at all", async () => {
    const { logs } = await runStories(
      {
        stories: [
          { id: "US-01", title: "新建项目", acceptance: [], source: "docs/a.md" },
          { id: "US-02", title: "配置环境", acceptance: [], source: "docs/a.md" },
        ],
      },
      "docs/a.md, docs/b.md",
    );
    const said = logs.find((l) => String(l.text ?? "").includes("没有故事出自"));
    expect(said?.text).toContain("docs/b.md");
    expect(said?.text).not.toContain("docs/a.md");
  });

  it("stays quiet when every document contributed", async () => {
    const { logs } = await runStories(
      {
        stories: [
          { id: "US-01", title: "新建项目", acceptance: [], source: "docs/a.md" },
          { id: "US-02", title: "进程页", acceptance: [], source: "docs/b.md" },
        ],
      },
      "docs/a.md, docs/b.md",
    );
    expect(logs.some((l) => String(l.text ?? "").includes("没有故事出自"))).toBe(false);
  });

  it("stays quiet for a single document, where the question does not arise", async () => {
    const { logs } = await runStories(
      { stories: [{ id: "US-01", title: "新建项目", acceptance: [] }] },
      "docs/a.md",
    );
    expect(logs.some((l) => String(l.text ?? "").includes("没有故事出自"))).toBe(false);
  });
});

describe("when the stories do not say where they came from", () => {
  it("says the attribution is missing rather than accusing every document", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const node = planStoriesNode({
      model: new FakeModel(() => JSON.stringify({ stories: [{ id: "US-01", title: "a", acceptance: [] }] })),
    });
    await node.run(
      { text: "x", origin: "docs/a.md, docs/b.md", title: "", rules: [], unknowns: [] },
      { maxStories: 12 },
      {
        nodeId: "stories",
        ablated: new Set(),
        spend: () => {},
        emit: (kind: string, payload: Record<string, unknown>) => logs.push({ kind, ...payload }),
      } as never,
    );
    const said = String(logs.find((l) => String(l.text ?? "").includes("文档"))?.text ?? "");
    expect(said).toContain("无法判断每份材料是否都被覆盖到");
  });
});

describe("the case budget", () => {
  it("reaches the model, and still trims a reply that ignores it", async () => {
    // `maxCasesPerStory` used to be a slice and nothing else: raising it changed how many
    // cases were kept and not how many were designed, so the two settings produced the
    // same batch and comparing them measured run-to-run noise.
    const model = new FakeModel(() =>
      JSON.stringify({
        cases: Array.from({ length: 6 }, (_, i) => ({
          title: `case ${i}`,
          designMethod: "equivalence",
          steps: ["a"],
          expected: "显示 X",
          tier: 1,
          key: `k${i}`,
        })),
      }),
    );
    const node = designCasesNode({ model });
    const out = await node.run(
      { origin: "t", derivedFrom: "document" as const, stories: [{ id: "US-01", title: "s", acceptance: ["a"] }] },
      { contextTokens: 2000, perStoryMaxTokens: 2000, maxCasesPerStory: 4, specText: "spec", oracleGuidance: "default" as const },
      {
        nodeId: "design",
        ablated: new Set(),
        spend: () => {},
        emit: () => {},
        signal: new AbortController().signal,
      } as never,
    );
    expect(model.calls[0]!.variable).toContain("CASE BUDGET: at most 4 cases");
    // The stable half must stay identical between runs, or the prefix cache never hits.
    expect(model.calls[0]!.stable).not.toContain("CASE BUDGET: at most 4");
    expect(out.cases).toHaveLength(4);
  });
});

describe("the stricter oracle guidance", () => {
  it("is a parameter, so the critic's standing proposal can be compared instead of believed", async () => {
    const run = async (oracleGuidance: "default" | "strict") => {
      const model = new FakeModel(() =>
        JSON.stringify({
          cases: [{ title: "a", designMethod: "equivalence", steps: ["s"], expected: "显示 X", tier: 1, key: "k" }],
        }),
      );
      const node = designCasesNode({ model });
      await node.run(
        { origin: "t", derivedFrom: "document" as const, stories: [{ id: "US-01", title: "s", acceptance: ["a"] }] },
        { contextTokens: 2000, perStoryMaxTokens: 2000, maxCasesPerStory: 4, specText: "spec", oracleGuidance },
        { nodeId: "design", ablated: new Set(), spend: () => {}, emit: () => {}, signal: new AbortController().signal } as never,
      );
      return model.calls[0]!;
    };
    const plain = await run("default");
    const strict = await run("strict");
    expect(plain.stable).not.toContain("WHAT COUNTS AS AN OBSERVABLE PHENOMENON");
    expect(strict.stable).toContain("WHAT COUNTS AS AN OBSERVABLE PHENOMENON");
    // Still in the stable half: a run's prefix is constant, which is what the cache needs.
    expect(strict.variable).not.toContain("WHAT COUNTS AS AN OBSERVABLE PHENOMENON");
  });
});
