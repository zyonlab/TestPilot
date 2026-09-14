import { describe, it, expect } from "vitest";
import { checkRun } from "../src/chat.js";
import { listGraphs } from "../src/graphs.js";

const GRAPH = listGraphs()[0]!.id;

/**
 * chat 起的跑与按钮起的跑，在 `run.detail` 上必须无法区分——做法是 chat **根本不起跑**：
 * 它只产出一张确认卡，按下去的是人，走的是界面上那个一模一样的 start()。
 * 所以这里能测的、也该测的，是那张卡在按下之前拦住了什么。
 */
describe("U-57 · 起跑草稿在按下之前就得站得住", () => {
  it("图不存在就不让按", () => {
    const d = checkRun({ graphId: "g-does-not-exist" });
    expect(d.valid).toBe(false);
    expect(d.issues.join()).toContain("g-does-not-exist");
  });

  it("编一个不存在的消融开关就不让按", () => {
    const d = checkRun({ graphId: GRAPH, ablate: ["not-a-switch"] });
    expect(d.valid).toBe(false);
    expect(d.issues.join()).toContain("not-a-switch");
  });

  it("覆盖一个图上没有的节点就不让按", () => {
    const d = checkRun({ graphId: GRAPH, params: { nope: { x: 1 } } });
    expect(d.valid).toBe(false);
    expect(d.issues.join()).toContain("nope");
  });

  it("没给上限不是错，但要说出来——一次没有上限的运行停不下来", () => {
    const d = checkRun({ graphId: GRAPH });
    expect(d.valid).toBe(true);
    expect((d.warnings ?? []).join()).toContain("上限");
  });

  it("草稿的 kind 是 run——它不会被当成图或能力去保存", () => {
    expect(checkRun({ graphId: GRAPH }).kind).toBe("run");
  });
});
