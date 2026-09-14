import { describe, it, expect, vi } from "vitest";
import { runCase, runP0, type GatewayFetch } from "../src/runcase.js";

/** T-14：工具只翻译网关的回答；截图不回传、日志截 2KB、unobservable 单列、账汇总。 */
const runRecord = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, caseId: "tc-1", caseTitle: "市价开多", status, durationMs: 1000, logs: ["step 1", "x".repeat(5000)], screenshots: ["data:image/png;base64,AAAA"],
  oracle: [{ assertion: "szi eq 0.001", status: status === "passed" ? "pass" : status === "unobservable" ? "unobservable" : "fail", decidedBy: "machine" }],
  spend: { modelCalls: 2, tokens: 300, modelMs: 40, cacheHits: 1, cacheMisses: 1, cacheStale: 0 }, reportPath: "/r/run-1.html", ...extra,
});
const gateway = (routes: Record<string, unknown>): GatewayFetch => async (url) => {
  const key = Object.keys(routes).find((k) => url.includes(k));
  return { ok: !!key, status: key ? 200 : 404, json: async () => (key ? routes[key] : { error: "no route" }) };
};

describe("run_case", () => {
  it("carries a managed run snapshot through case and suite execution", async () => {
    vi.stubEnv("TP_MODEL_RUN_ID", "managed-original");
    const bodies: Record<string, unknown>[] = [];
    const f: GatewayFetch = async (url, init) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => url.includes("suite")
        ? { gate: "pass", batch: { id: "b", total: 0 }, items: [] }
        : url.includes("/runs/") || url.endsWith("/run") ? { run: runRecord("r", "passed") }
        : { cases: [{ id: "tc-1", title: "A" }] } };
    };
    try {
      await runCase({ projectId: "p", caseId: "tc-1", fetchImpl: f });
      await runP0({ projectId: "p", fetchImpl: f });
      expect(bodies).toHaveLength(2);
      expect(bodies.every(b => b.modelSnapshotRunId === "managed-original")).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it("按标题找到用例、跑一次、回判决与账，不回截图，日志截 2KB", async () => {
    const f = gateway({
      "/api/cases?projectId=": { cases: [{ id: "tc-1", title: "市价开多 0.001 BTC", priority: "P0" }] },
      "/api/cases/tc-1/run": { run: runRecord("run-1", "passed") },
      "/api/runs/run-1": { run: runRecord("run-1", "passed") },
    });
    const v = await runCase({ projectId: "p", title: "市价开多", fetchImpl: f });
    expect(v.status).toBe("passed");
    expect(v.oracle[0].decidedBy).toBe("machine");
    expect(v.spend).toMatchObject({ modelCalls: 2 });
    expect((v as unknown as { screenshots?: unknown }).screenshots).toBeUndefined();
    expect(v.logs.length).toBeLessThan(2200);
    expect(v.reportPath).toBe("/r/run-1.html");
  });

  it("标题不唯一就报错要 caseId；失败带 failure.kind", async () => {
    const f = gateway({
      "/api/cases?projectId=": { cases: [{ id: "tc-1", title: "市价开多 A" }, { id: "tc-2", title: "市价开多 B" }] },
      "/api/cases/tc-2/run": { run: runRecord("run-2", "failed", { failKind: "assert", failCode: "EXEC_ASSERT", failureReason: "szi 0.002" }) },
      "/api/runs/run-2": { run: runRecord("run-2", "failed", { failKind: "assert", failCode: "EXEC_ASSERT", failureReason: "szi 0.002" }) },
    });
    await expect(runCase({ projectId: "p", title: "市价开多", fetchImpl: f })).rejects.toThrow(/匹配到 2 条/);
    const v = await runCase({ projectId: "p", caseId: "tc-2", fetchImpl: f });
    expect(v.status).toBe("failed");
    expect(v.failure).toMatchObject({ kind: "assert", code: "EXEC_ASSERT" });
  });
});

describe("run_p0", () => {
  it("汇总：通过 / 失败 / unobservable / infra 分开数，账相加，没跑起来的记 infra", async () => {
    const f = gateway({
      "/api/projects/p/suite": { gate: "fail", batch: { id: "bat-1", total: 3, passed: 1, failed: 1 }, items: [
        { runId: "run-a", caseId: "tc-1", caseTitle: "A", status: "passed" },
        { runId: "run-b", caseId: "tc-2", caseTitle: "B", status: "failed" },
        { runId: null, caseId: "tc-3", caseTitle: "C", status: "failed" },
      ] },
      "/api/runs/run-a": { run: runRecord("run-a", "passed") },
      "/api/runs/run-b": { run: runRecord("run-b", "unobservable") },
    });
    const r = await runP0({ projectId: "p", fetchImpl: f });
    expect(r.gate).toBe("fail");
    expect([r.passed, r.failed, r.unobservable, r.infra]).toEqual([1, 1, 1, 1]);
    expect(r.spend).toMatchObject({ modelCalls: 4, tokens: 600 });
    expect(r.cases.find((c) => c.caseId === "tc-3")?.failure?.kind).toBe("infra");
  });
});
