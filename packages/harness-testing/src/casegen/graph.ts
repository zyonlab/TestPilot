import { NodeRegistry, type GraphDef, type ModelClient } from "@testpilot/harness-core";
import { caseGenNodes, type CaseGenNodeOptions } from "./nodes.js";

/** A registry holding the stage-one node types. */
export function caseGenRegistry(opts: CaseGenNodeOptions): NodeRegistry {
  const registry = new NodeRegistry();
  for (const node of caseGenNodes(opts)) registry.register(node);
  return registry;
}

export interface G1Params {
  /** Where the specification comes from. */
  spec: { path?: string; text?: string };
  maxStories?: number;
  minNegativeRatio?: number;
  maxSteps?: number;
  /** Context handed to the design node; usually the same text as the spec. */
  specText?: string;
  /** Output language. Unset means "answer in the specification's language". */
  lang?: string;
  version?: number;
}

/**
 * G1 as a graph definition: specification → stories → cases → gate.
 *
 * It is data, not code, because that is what makes it editable on the canvas, versionable,
 * and pinnable into a run. This function only builds the default shape.
 */
export function g1Graph(params: G1Params): GraphDef {
  return {
    id: "g1-text-cases",
    version: params.version ?? 1,
    nodes: [
      // 用户给的文档是**材料**，不是规格。它先被整理成那份唯一的标准规格，下游才开始工作——
      // 否则「用户这次给的是什么格式」这个问题会被复制到每一个下游节点里。
      { id: "docs", type: "source.spec", params: params.spec },
      { id: "spec", type: "spec.compose", params: { lang: params.lang } },
      { id: "stories", type: "plan.stories", params: { maxStories: params.maxStories ?? 12, lang: params.lang } },
      {
        id: "design",
        type: "design.cases",
        params: { specText: params.specText ?? params.spec.text ?? "", lang: params.lang },
      },
      {
        id: "gate",
        type: "gate.textcase",
        params: {
          minNegativeRatio: params.minNegativeRatio ?? 0.3,
          maxSteps: params.maxSteps ?? 8,
        },
      },
    ],
    edges: [
      { from: "docs", to: "spec" },
      { from: "spec", to: "stories" },
      { from: "stories", to: "design" },
      { from: "design", to: "gate" },
    ],
  };
}

export function g1(model: ModelClient, params: G1Params, baseDir?: string) {
  return { registry: caseGenRegistry({ model, baseDir }), def: g1Graph(params) };
}
