import { describe, expect, it } from "vitest";
import { DOMAINS, actionIndex } from "../src/host/registry.js";
import { fillPath, describeActions } from "../src/host/tools.js";

/**
 * 宿主域工具的形状。业务逻辑全在服务端，所以这里钉的是**映射本身**：
 * 路径参数填得对不对、缺参数说不说人话、动作清单可不可读。
 * 「registry 指向的路由真的存在」由 `scripts/check-host-parity.mjs` 管，那条要读服务端源码。
 */
describe("宿主域工具", () => {
  it("十七个域，动作名不重复", () => {
    expect(DOMAINS.map((d) => d.tool)).toEqual(["tp_project", "tp_run", "tp_stage", "tp_unit", "tp_artifact",
      "tp_review", "tp_execution", "tp_case", "tp_report", "tp_export", "tp_settings", "tp_eval",
      "tp_queue", "tp_graph", "tp_wf", "tp_audit", "tp_system"]);
    expect(actionIndex().size).toBe(DOMAINS.reduce((n, d) => n + Object.keys(d.actions).length, 0));
  });

  it("路径参数按名字填，并且转义", () => {
    const spec = { summary: "", method: "GET" as const, path: "/api/p/:id/x/:hash", params: ["id", "hash"] as const };
    expect(fillPath(spec, { id: "a b", hash: "h/1" })).toBe("/api/p/a%20b/x/h%2F1");
  });

  it("缺参数当场说清缺哪个，而不是发一个注定 404 的请求", () => {
    const spec = { summary: "", method: "GET" as const, path: "/api/p/:id", params: ["id"] as const };
    expect(() => fillPath(spec, {})).toThrow(/缺少路径参数 id/);
  });

  it("registry 漏写 params 时也要拦住——路径里剩下的 :name 是个 bug", () => {
    const spec = { summary: "", method: "GET" as const, path: "/api/p/:id/y/:missing", params: ["id"] as const };
    expect(() => fillPath(spec, { id: "1" })).toThrow(/没填的参数 :missing/);
  });

  it("会改东西的动作在清单里标出来——agent 与人都要一眼看见", () => {
    const text = describeActions(DOMAINS.find((d) => d.tool === "tp_project")!);
    expect(text).toContain("create（会改东西）");
    expect(text).toContain("list —");
    expect(text).not.toContain("list（会改东西）");
  });

  /**
   * 摘要要能让 agent 选对动作。
   *
   * 第一版门槛是「长度 > 4」，结果 60 个动作被点名，其中「取消一次运行」这种
   * 本来就已经说清楚了——**硬凑字数是为了过测试，不是为了让 agent 看懂**。
   * 改成判信息量：说出它**动了什么东西**（名词），而不只是一个动词。
   */
  it("每个动作的摘要都说清它动的是什么，不只是一个动词", () => {
    const bareVerb = /^(读|改|删|列|起|跑|取消|导出|导入|新建)一?[次条个份]?$/;
    for (const [name, { spec }] of actionIndex()) {
      const summary = spec.summary.trim();
      expect(summary.length, `${name} 的摘要是空的`).toBeGreaterThan(2);
      expect(bareVerb.test(summary), `${name} 的摘要只有一个动词：${summary}`).toBe(false);
    }
  });

  it("需要运行凭证的都是写节点产物那一类", () => {
    for (const [name, { spec }] of actionIndex())
      if (spec.needsRunGrant) expect(name, name).toMatch(/^tp_(stage|unit|artifact|run)\./);
  });

  /**
   * 人做的决定要在摘要里说出来。宿主是 UI 的等价入口，不是「agent 可以自己拍板」的入口——
   * 冻结模块树、批准用例、立基线，在 UI 上是人点的，在宿主里也得是人说了才调。
   */
  it("人做的决定，摘要里要写明白", () => {
    const humanCalls = ["tp_stage.freeze_modules", "tp_review.decide", "tp_execution.set_baseline",
      "tp_case.approve_visual_baseline", "tp_case.approve_perf_baseline"];
    const index = actionIndex();
    for (const name of humanCalls) {
      const entry = index.get(name);
      expect(entry, name).toBeTruthy();
      expect(entry!.spec.summary, name).toMatch(/人的决定|人点头|人说了/);
      expect(entry!.spec.mutates, name).toBe(true);
    }
  });
});

it("planner tools omit operator decisions and reject forged calls before transport", async () => {
  const { registerHostDomains } = await import("../src/host/tools.js");
  const registered = new Map<string, { config: any; handler: any }>();
  let calls = 0;
  registerHostDomains({ registerTool(name, config, handler) { registered.set(name, { config, handler }); } }, { call: async () => { calls++; return {}; } } as any);
  const review = registered.get("tp_review")!;
  expect(review.config.inputSchema.action.options).not.toContain("decide");
  expect(registered.get("tp_stage")!.config.inputSchema.action.options).not.toContain("freeze_modules");
  expect((await review.handler({ action: "decide", params: { projectId: "p", runId: "r" }, body: {} })).isError).toBe(true);
  const evalTool = registered.get("tp_eval")!;
  expect(evalTool.config.inputSchema.action.options).not.toContain("set_gold");
  expect((await evalTool.handler({ action: "set_gold", params: { capability: "demo" }, body: { action: "freeze" } })).isError).toBe(true);
  expect(calls).toBe(0);
  await review.handler({ action: "list", params: { projectId: "p", runId: "r" } });
});
