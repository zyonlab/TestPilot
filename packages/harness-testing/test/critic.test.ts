import { describe, expect, it } from "vitest";
import { FakeModel } from "@testpilot/harness-core";
import { collectEvidence, critique } from "../src/critic.js";

const reply = (suggestions: unknown[]) => JSON.stringify({ suggestions });

const base = collectEvidence({
  runs: 3,
  gateFindings: [
    { rule: "invented-credential", message: "a literal 'testuser' is typed into 用户名输入框" },
    { rule: "invented-credential", message: "a literal 'testpass' is typed into 密码输入框" },
    { rule: "oracle-vague", message: "assertion promises nothing checkable" },
  ],
  outcomes: [
    { status: "failed", failKind: "infra" },
    { status: "failed", failKind: "assert" },
    { status: "passed" },
  ],
  degraded: ["c3"],
  repairRounds: [{ changes: ["selector-wording"] }, { changes: ["assertion-semantics"] }],
  coverageMisses: ["G-09", "G-12"],
  spend: { calls: 40, tokens: 120000 },
});

describe("collectEvidence", () => {
  it("aggregates findings by rule, most frequent first", () => {
    expect(base.gateFindings[0]).toMatchObject({ rule: "invented-credential", count: 2 });
    expect(base.gateFindings[0].examples).toHaveLength(2);
  });

  it("keeps the failure buckets apart — an environment failure is not a harness fault", () => {
    expect(base.failures).toEqual({ infra: 1, locate: 0, assert: 1 });
  });

  it("counts what repair rounds actually changed", () => {
    expect(base.repairChanges).toEqual({ "selector-wording": 1, "assertion-semantics": 1 });
  });
});

describe("critique", () => {
  it("puts the evidence in front of the model, in aggregate", async () => {
    const model = new FakeModel(reply([]));
    await critique(base, model);
    const call = model.calls[0];
    expect(call.variable).toContain("invented-credential: 2");
    expect(call.variable).toContain("infra 1, locate 0, assert 1");
    expect(call.variable).toContain("G-09");
    expect(call.stable).toContain("Never propose harness changes for those");
  });

  /**
   * Two things the critic is forbidden to suggest, both observed being suggested before the
   * rule existed: relaxing a gate, and putting the gold checklist into a prompt. The second
   * is the subtler one — it raises the coverage number by destroying what the number means.
   */
  it("forbids the two proposals that would make the numbers lie", async () => {
    const model = new FakeModel(reply([]));
    await critique(base, model);
    expect(model.calls[0].stable).toContain("Do not propose weakening a gate");
    expect(model.calls[0].stable).toContain("Never propose putting the checklist");
  });

  it("counts how many suggestions can actually be settled by an evaluation", async () => {
    const model = new FakeModel(
      reply([
        {
          title: "Give the generator the placeholders",
          target: "prompt",
          change: "hand ${env.USERNAME} in the prompt instead of asking for it",
          evidence: "invented-credential fired twice",
          test: { kind: "ablation", handle: "design-methods" },
          expectedEffect: "fewer blocked cases",
        },
        {
          title: "Rewrite the specification fixture",
          target: "fixture",
          change: "add the missing acceptance criteria",
          evidence: "G-09 and G-12 uncovered",
          test: { kind: "manual" },
        },
      ]),
    );
    const out = await critique(base, model, { ablatable: ["design-methods", "oracle-grading"] });
    expect(out.suggestions).toHaveLength(2);
    expect(out.testable).toBe(1);
  });

  it("downgrades a suggestion that names a switch the harness does not have", async () => {
    const model = new FakeModel(
      reply([
        {
          title: "Turn off the memory layer",
          target: "node-param",
          change: "disable memory",
          evidence: "…",
          test: { kind: "ablation", handle: "memory" },
        },
      ]),
    );
    const out = await critique(base, model, { ablatable: ["design-methods"] });
    // Claiming a comparison that cannot be run would produce a report about nothing.
    expect(out.suggestions[0].test.kind).toBe("manual");
    expect(out.suggestions[0].expectedEffect).toContain("no such ablation switch");
    expect(out.testable).toBe(0);
  });

  it("fails loudly when the reply is not usable", async () => {
    await expect(critique(base, new FakeModel("I would suggest a few things…"))).rejects.toThrow(/no JSON object/);
  });

  it("rejects a reply whose suggestions do not carry evidence", async () => {
    const model = new FakeModel(reply([{ title: "do better", target: "prompt", change: "improve it" }]));
    await expect(critique(base, model)).rejects.toThrow(/harness-critic/);
  });
});

describe("the checklist ban, enforced rather than merely stated", () => {
  const evidence = collectEvidence({
    runs: 6,
    gateFindings: [{ rule: "oracle-vague", message: "assertion names no observable phenomenon" }],
    coverageMisses: ["保存节点参数后图版本号递增", "点击节点后右侧显示该节点的产物"],
  });

  it("marks a suggestion that recites an uncovered checklist item back into a prompt", async () => {
    // The prompt has banned this from the start. The critic did it anyway on a real run:
    // "For items like '点击节点后右侧显示该节点的产物' … require the planner to generate a case".
    const model = new FakeModel(() =>
      JSON.stringify({
        suggestions: [
          {
            title: "Improve story planning",
            target: "prompt",
            change:
              "Modify the story planning prompt: for items like 「点击节点后右侧显示该节点的产物」, require a case that targets it.",
            evidence: "10 checklist items uncovered",
            test: { kind: "ablation", handle: "design-methods" },
          },
        ],
      }),
    );
    const out = await critique(evidence, model, { ablatable: ["design-methods"] });
    expect(out.suggestions[0].inadmissible).toMatch(/checklist item into a prompt/);
    // And it is not offered as something to spend an evaluation on.
    expect(out.testable).toBe(0);
  });

  it("leaves a proposal about how the material is read alone", async () => {
    const model = new FakeModel(() =>
      JSON.stringify({
        suggestions: [
          {
            title: "Read acceptance criteria one by one",
            target: "prompt",
            change: "Ask the planner to walk the acceptance criteria of each story separately.",
            evidence: "10 checklist items uncovered",
            test: { kind: "ablation", handle: "design-methods" },
          },
        ],
      }),
    );
    const out = await critique(evidence, model, { ablatable: ["design-methods"] });
    expect(out.suggestions[0].inadmissible).toBeUndefined();
    expect(out.testable).toBe(1);
  });
});
