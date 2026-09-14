import { afterEach, describe, expect, it, vi } from "vitest";
import { plannerModel, plannerConnectionFromEnv, executorConnectionFromEnv, environmentModelProfile, evaluationPlannerModel } from "../src/model/role-client.js";
import type { RoleModelConnection } from "../src/model/profiles.js";
import { modelFingerprint } from "../src/model/client.js";

afterEach(() => vi.unstubAllGlobals());
const env = { TP_PLANNER_MODEL_NAME: "reasoner", TP_PLANNER_BASE_URL: "https://planner.test/v1", TP_PLANNER_API_KEY: "planner-only",
  MIDSCENE_MODEL_NAME: "vision", MIDSCENE_MODEL_BASE_URL: "https://executor.test/v1", MIDSCENE_MODEL_API_KEY: "executor-only" };

describe("role connection routing", () => {
  it("uses planner transport for semantic evaluation even with an explicit judge model name", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    await evaluationPlannerModel({ ...env, TP_JUDGE_MODEL: "independent-judge" }).chat({ stable: "", variable: "evaluate" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://planner.test/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer planner-only" });
    expect(JSON.parse(String(init.body)).model).toBe("independent-judge");
  });
  it("never treats a Midscene-only setup as a configured planner", () => {
    expect(() => plannerConnectionFromEnv({ MIDSCENE_MODEL_NAME: "vision", OPENAI_BASE_URL: "https://executor.test/v1" })).toThrow("missing_profile (planner)");
    expect(plannerConnectionFromEnv(env)).toMatchObject({ role: "planner", model: "reasoner", apiKey: "planner-only" });
    expect(executorConnectionFromEnv(env)).toMatchObject({ role: "executor", model: "vision", apiKey: "executor-only" });
  });
  it("changes env profile identity on a model change without exposing the credential", () => {
    const a = environmentModelProfile("planner", env)!;
    const b = environmentModelProfile("planner", { ...env, TP_PLANNER_MODEL_NAME: "other" })!;
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(a)).not.toContain("planner-only");
    expect(modelFingerprint({ model: "same", noThink: false, providerThinkingDefault: true }))
      .not.toBe(modelFingerprint({ model: "same", noThink: false }));
  });
  it("rejects an executor connection passed to the planner", () => {
    expect(() => plannerModel(executorConnectionFromEnv(env))).toThrow("invalid_profile (planner)");
  });
  it("does not borrow the host key after an explicit executor credential clear", () => {
    expect(executorConnectionFromEnv({ ...env, MIDSCENE_MODEL_API_KEY: "", OPENAI_API_KEY: "host-key" }).apiKey).toBe("");
    expect(() => executorConnectionFromEnv({ ...env, MIDSCENE_MODEL_BASE_URL: "", OPENAI_BASE_URL: "https://host.test/v1" })).toThrow("invalid_profile (executor)");
  });
  it("keeps concurrent clients isolated and does not send thinking controls for provider default", async () => {
    const sent: Array<{ endpoint: unknown; key: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (endpoint, init) => {
      sent.push({ endpoint, key: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 1 } }));
    }));
    const first = plannerConnectionFromEnv(env);
    const second: RoleModelConnection = { ...first, model: "second", endpoint: "https://second.test/v1", apiKey: "second-only" };
    const a = plannerModel(first), b = plannerModel(second);
    second.apiKey = "mutated-after-snapshot";
    await Promise.all([a.chat({ stable: "", variable: "A", maxTokens: 32 }), b.chat({ stable: "", variable: "B", maxTokens: 32 })]);
    expect(sent.map(r => r.key)).toEqual(["Bearer planner-only", "Bearer second-only"]);
    expect(sent.map(r => r.endpoint)).toEqual(["https://planner.test/v1/chat/completions", "https://second.test/v1/chat/completions"]);
    expect(sent[0].body).not.toHaveProperty("enable_thinking");
    expect(sent[0].body).not.toHaveProperty("thinking_budget");
    expect(sent[0].body.max_tokens).toBe(32);
  });
});
