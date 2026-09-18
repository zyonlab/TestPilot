import { describe, expect, it, vi } from "vitest";

/**
 * The chat drafts; the checks decide. These cover the part that matters when a model is
 * writing the artefact: what gets refused, and that refusing is visible rather than quiet.
 */

const replies: string[] = [];

vi.mock("../src/datadir.js", () => ({ DATA_DIR: ":memory:", dataPath: () => ":memory:", INSTANCE: "test" }));
vi.mock("../src/procs.js", () => ({
  bus: { subscribe: () => ({ close: () => undefined }) },
  setAgentExecutor: () => undefined,
  supervisor: { statusOf: () => ({ state: "alive" }), start: async () => undefined, rpc: () => undefined },
}));
vi.mock("../src/exec.js", () => ({ execOnRunner: async () => ({ status: "passed" }) }));
vi.mock("../src/db.js", () => ({
  ARTIFACT_DIR: "/tmp",
  getProject: () => undefined,
  getSecretValues: () => ({}),
  resolveEnvironment: () => undefined,
}));
vi.mock("../src/settings.js", () => ({
  DEFAULT_PROMPTS: { explore: "x", generateCode: "y" },
  getSettings: () => ({
    prompts: {
      explore: "Design flows for ${env.APP}. Never inline ${secret.PASSWORD}. Return JSON.",
      generateCode: "y",
    },
  }),
}));
vi.mock("@testpilot/harness-core", async (actual) => {
  const core = (await actual()) as Record<string, unknown>;
  const { FakeModel } = core as { FakeModel: new (r: () => string) => unknown };
  return { ...core, plannerConnectionFromEnv: () => ({ role: "planner" }), plannerModel: () => new FakeModel(() => replies.shift() ?? "{}") };
});

const { chat, checkGraph, checkPrompt, checkRecipe } = await import("../src/chat.js");
const { listGraphs } = await import("../src/graphs.js");

describe("a capability recipe a model wrote", () => {
  it("refuses a shell line dressed up as a command", () => {
    const draft = checkRecipe(
      { id: "anvil-2", kind: "chain", command: "npx anvil --port 8546 && rm -rf ~", args: [] },
      [],
    );
    expect(draft.valid).toBe(false);
    expect(draft.issues.join(" ")).toMatch(/bare program name/);
  });

  it("refuses a command carrying its own arguments, and a shell as the command", () => {
    // Found by running it: the first version of this rule only looked for shell
    // metacharacters, so `sh -c "rm -rf /tmp/x"` sailed through — it has none.
    expect(
      checkRecipe({ id: "sneaky", kind: "other", command: 'sh -c "rm -rf /tmp/x"' }, []).issues.join(" "),
    ).toMatch(/bare program name/);
    expect(
      checkRecipe({ id: "sneaky", kind: "other", command: "bash", args: ["-c", "rm -rf ~"] }, []).issues.join(" "),
    ).toMatch(/shell cannot be the command/);
    expect(checkRecipe({ id: "ok", kind: "mock", command: "node", args: ["mock.js"] }, []).valid).toBe(true);
  });

  it("refuses an id that is already a running process", () => {
    const recipe = { id: "runner", kind: "mock", command: "node", args: ["mock.js"] };
    expect(checkRecipe(recipe, ["gateway", "runner"]).issues.join(" ")).toMatch(/already taken/);
    expect(checkRecipe(recipe, ["gateway"]).valid).toBe(true);
  });

  it("accepts a well-formed recipe with a readiness probe", () => {
    const draft = checkRecipe(
      {
        id: "mock-api",
        kind: "mock",
        command: "node",
        args: ["scripts/mock.js"],
        healthcheck: { kind: "http", url: "http://127.0.0.1:4010/health", expectStatus: 200 },
      },
      [],
    );
    expect(draft).toMatchObject({ valid: true, issues: [] });
  });
});

describe("a graph a model drafted", () => {
  it("is checked by the same validator the canvas saves through", () => {
    const real = listGraphs().find((g) => g.id === "g1-text-cases")!;
    expect(checkGraph(real).valid).toBe(true);
    const broken = { ...real, nodes: [...real.nodes, { id: "made-up", type: "does.not.exist" }] };
    const draft = checkGraph(broken);
    expect(draft.valid).toBe(false);
    expect(draft.issues.join(" ")).toMatch(/does\.not\.exist|unknown/i);
  });

  it("says what a draft would drop, even though dropping validates fine", () => {
    // Found by running it against the real model: asked to change one parameter, it
    // returned the graph with every other parameter gone. Params have defaults, so the
    // result validated — and would have silently changed which file the run reads.
    const real = listGraphs().find((g) => g.id === "g1-text-cases")!;
    const stripped = { ...real, nodes: real.nodes.map((n) => ({ id: n.id, type: n.type, params: {} })) };
    const draft = checkGraph(stripped);
    expect(draft.valid).toBe(true);
    expect(draft.warnings?.join(" ")).toMatch(/would be dropped/);
    // 2026-09-18 起读文件的 docs 节点不再有默认路径（产品代码不指向仓库夹具），
    // 所以这里改看 spec 节点：丢掉的参数一样要被说出来。
    expect(draft.warnings?.some((w) => w.startsWith("spec."))).toBe(true);
    expect(draft.diff?.length).toBeGreaterThan(0);
  });
});

describe("a prompt rewrite", () => {
  it("refuses one that quietly drops a placeholder", () => {
    const draft = checkPrompt("Design flows for the app. Return JSON.", "explore");
    expect(draft.valid).toBe(false);
    expect(draft.issues.join(" ")).toContain("${env.APP}");
  });

  it("accepts one that keeps them", () => {
    const draft = checkPrompt(
      "Design flows for ${env.APP}, negative cases first. Never inline ${secret.PASSWORD}. Return JSON.",
      "explore",
    );
    expect(draft.valid).toBe(true);
  });
});

describe("the chat itself", () => {
  it("returns the draft with its errors rather than hiding a bad one", async () => {
    replies.push(JSON.stringify({ reply: "here you go", recipe: { id: "BAD ID", kind: "chain", command: "anvil" } }));
    const out = await chat({ messages: [{ role: "user", text: "give me a local chain" }], intent: "capability" });
    expect(out.reply).toBe("here you go");
    expect(out.draft?.valid).toBe(false);
    expect(out.draft?.issues.join(" ")).toMatch(/lowercase letters/);
  });

  it("says the reply produced no draft instead of inventing one", async () => {
    replies.push("I would love to help but here is some prose.");
    const out = await chat({ messages: [{ role: "user", text: "a chain" }], intent: "capability" });
    expect(out.draft).toBeUndefined();
    expect(out.reply).toContain("prose");
  });

  it("gives the model the palette and the current graph when drafting a graph", async () => {
    replies.push(JSON.stringify({ reply: "added nothing", graph: listGraphs()[0] }));
    const out = await chat({
      messages: [{ role: "user", text: "add a node" }],
      intent: "graph",
      graphId: "g1-text-cases",
    });
    expect(out.draft?.kind).toBe("graph");
    expect(out.draft?.valid).toBe(true);
  });
});
