import { ABLATABLE, type DomainPack, type ModelClient } from "@testpilot/harness-core";
import { caseGenNodes, g1Graph, type ProductObserver } from "./casegen/index.js";
import { codeGenNodes, type CaseExecutor } from "./codegen/index.js";

/**
 * This vertical, packaged.
 *
 * Everything the testing domain adds — the nodes, the graphs it ships, what it lets an
 * ablation switch off — in one object. The host registers it; it does not import the nodes
 * one at a time and hope the list stayed complete.
 */
export function testingPack(opts: {
  model: ModelClient;
  executor?: CaseExecutor;
  /** Present when this process can reach a browser: enables the black-box source. */
  observer?: ProductObserver;
  baseDir?: string;
  specPath?: string;
}): DomainPack {
  const specPath = opts.specPath ?? "fixtures/mock-spec/acme-portal.md";
  const g1 = g1Graph({ spec: { path: specPath }, lang: "zh" });
  return {
    name: "testing",
    description: "Specification → text cases → code → bounded repair",
    nodes: [
      ...caseGenNodes({ model: opts.model, baseDir: opts.baseDir, observer: opts.observer }),
      ...codeGenNodes(opts),
    ],
    graphs: [
      g1,
      {
        id: "g1-g2-full",
        version: 1,
        nodes: [
          ...g1.nodes,
          { id: "codegen", type: "codegen.case" },
          { id: "codegate", type: "gate.code" },
          { id: "repair", type: "repair.loop", params: { maxRounds: 1, limit: 3 } },
        ],
        edges: [
          ...g1.edges,
          { from: "gate", to: "codegen" },
          { from: "codegen", to: "codegate" },
          { from: "codegate", to: "repair" },
        ],
      },
      {
        // 黑盒那条路：**explore → spec → 故事 → 用例**。
        //
        // 它和 g1 只差第一个节点——两者都经过 `spec.compose`，因为标准规格只有一处产出。
        // 材料从哪来是这一层的事，下游一个字都不用改。分成两张图而不是给 g1 加一个开关，
        // 是因为「读文档」和「看产品」是两次不同的运行、会得出不同的东西，也该分别评测。
        id: "g0-explore",
        version: 1,
        nodes: [
          { id: "explore", type: "source.explore", params: { deep: true, lang: "zh" } },
          { id: "spec", type: "spec.compose", params: { lang: "zh" } },
          { id: "stories", type: "plan.stories", params: { maxStories: 12, lang: "zh" } },
          { id: "design", type: "design.cases", params: { lang: "zh" } },
          { id: "gate", type: "gate.textcase", params: { minNegativeRatio: 0.3, maxSteps: 8 } },
        ],
        edges: [
          { from: "explore", to: "spec" },
          { from: "spec", to: "stories" },
          { from: "stories", to: "design" },
          { from: "design", to: "gate" },
        ],
      },
      {
        id: "g2-code",
        version: 1,
        // Starts halfway down: seeded with a stage-one bundle, which is how "take
        // yesterday's cases and generate code" works without re-asking the model.
        nodes: [
          { id: "codegen", type: "codegen.case" },
          { id: "codegate", type: "gate.code" },
          { id: "repair", type: "repair.loop", params: { maxRounds: 1, limit: 3 } },
        ],
        edges: [
          { from: "codegen", to: "codegate" },
          { from: "codegate", to: "repair" },
        ],
      },
    ],
    ablatable: Object.values(ABLATABLE),
  };
}
