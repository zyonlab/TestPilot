import { executionBlockers } from "./readiness.js";
import type { TextCase } from "./types.js";

/**
 * 设计证据的确定性交叉校验（docs/v3/history/21 §5）。
 *
 * 这里只查**结构上可判**的事：方法标签和证据是否说同一件事、判定行的赋值是否落在
 * 它自己列出的条件上、状态边是否和 `covers` 对得上、断言 id 有没有重复、
 * 执行不就绪时有没有说为什么。「这段规格是否真的支持这条断言」不在这里判，那是人的事。
 *
 * **八个字段全是可选的，所以每一条检查都只在字段出现时才触发。** 旧归档一条都不会被点到——
 * 它们本来就没有这些字段，而「没给证据」与「给了坏证据」是两件事，只有后者是错误。
 */
export interface EvidenceError {
  caseId: string;
  code: string;
  jsonPointer: string;
  message: string;
}

/** `designMethod` 里的 `negative` 是场景不是方法，迁移期两者并存。 */
const METHOD_TO_TECHNIQUE: Record<string, string | undefined> = {
  equivalence: "equivalence",
  boundary: "boundary",
  "decision-table": "decision-table",
  "state-transition": "state-transition",
  exploratory: "exploratory",
  negative: undefined,
};

export function checkDesignEvidence(cases: TextCase[]): EvidenceError[] {
  const errors: EvidenceError[] = [];
  cases.forEach((c, i) => {
    const at = (field: string) => `/cases/${i}/${field}`;
    const push = (code: string, field: string, message: string) =>
      errors.push({ caseId: c.id, code, jsonPointer: at(field), message });

    if (c.design) {
      const expected = METHOD_TO_TECHNIQUE[c.designMethod];
      if (expected && c.design.technique !== expected)
        push("design_technique_mismatch", "design/technique",
          `designMethod=${c.designMethod} 与 design.technique=${c.design.technique} 说的不是同一种方法`);
      if (c.design.technique === "decision-table") {
        const conditions = new Set(c.design.conditionIds);
        for (const key of Object.keys(c.design.assignment))
          if (!conditions.has(key))
            push("decision_row_unknown_condition", "design/assignment",
              `这一行给 ${key} 赋了值，但它不在自己列出的 conditionIds 里`);
        for (const id of c.design.conditionIds)
          if (!(id in c.design.assignment))
            push("decision_row_missing_condition", "design/assignment",
              `条件 ${id} 在这一行里没有取值——一张有空格的判定表说不出这一行测的是什么`);
      }
      if (c.design.technique === "state-transition" && (c.covers ?? []).length) {
        const covered = new Set(c.covers);
        for (const id of c.design.transitionIds)
          if (!covered.has(id))
            push("transition_not_in_covers", "design/transitionIds",
              `设计证据说走了 ${id}，而 covers 里没有它；两处说的必须是同一批边`);
      }
      if (c.design.technique === "boundary" && !c.design.points.some((p) => p.at === "at"))
        push("boundary_without_the_bound", "design/points",
          "取了边界附近的点，却没有取边界上那一点——边界值分析的核心正是那一点");
    }

    if (c.assertions) {
      const ids = c.assertions.map((a) => a.id);
      if (new Set(ids).size !== ids.length) push("duplicate_assertion_id", "assertions", "同一条用例里断言 id 重复");
      c.assertions.forEach((a, k) => {
        if (c.tier <= 2 && !a.oracle && !c.oracle)
          errors.push({ caseId: c.id, code: "assertion_without_oracle", jsonPointer: at(`assertions/${k}/oracle`),
            message: `声称 tier ${c.tier} 却没有任何程序判据：断言 ${a.id} 和用例本身都没给` });
      });
    }

    if (c.readiness?.execution === "ready") for (const issue of executionBlockers(c))
      push("ready_without_evidence", "readiness", issue);

    if (c.risk && !c.priority)
      push("risk_without_priority", "risk", "给了风险理由，却没有给优先级——理由在解释一个不存在的判断");

    if (c.readiness && c.readiness.execution !== "ready" && !c.readiness.reason)
      push("readiness_without_reason", "readiness/reason",
        `执行就绪状态是 ${c.readiness.execution}，必须说出缺什么；否则它和"忘了填"分不开`);

    if (c.scenarioType === "negative" && c.designMethod !== "negative" && !c.design)
      push("negative_without_design", "design",
        "标了负向场景又标了某种设计方法，却没有给设计证据——负例同样是用某种方法设计出来的");
  });
  return errors;
}
