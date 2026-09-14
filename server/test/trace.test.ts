import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

/**
 * Traceability's contract: both directions are answerable, and an assertion that quotes
 * interface text is checked against the material the run was actually given.
 *
 * The grounding check is the part worth guarding: it must not call a case wrong (the words
 * may be real and merely undocumented) and must not call it fine just because there was
 * nothing to check against.
 */

const outputs: Record<string, unknown> = {};
const runs: Record<string, unknown> = { "wf-1": { id: "wf-1", graphId: "g1", status: "done" } };

vi.mock("../src/graphs.js", () => ({
  nodeOutput: async (wfRunId: string, nodeId: string) => outputs[`${wfRunId}:${nodeId}`],
  // 追溯按**形状**找材料节点，不按 id——不同的图里它叫 docs 或 explore。
  allOutputs: async (wfRunId: string) =>
    Object.fromEntries(
      Object.entries(outputs)
        .filter(([k]) => k.startsWith(`${wfRunId}:`))
        .map(([k, v]) => [k.slice(wfRunId.length + 1), v]),
    ),
  outputStore: { getRun: (id: string) => runs[id], listRuns: () => Object.values(runs) },
}));

const dir = resolve(tmpdir(), `tp-trace-${process.pid}`);
let db: typeof import("../src/db.js");
let tr: typeof import("../src/trace.js");

beforeEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  process.env.TP_DATA_DIR = dir;
  vi.resetModules();
  db = await import("../src/db.js");
  tr = await import("../src/trace.js");
  outputs["wf-1:stories"] = {
    stories: [
      { id: "US-01", title: "新建项目", acceptance: ["目标端为 web 时可选启用 web3 能力"], source: "docs/archive/spec/02.md" },
      { id: "US-02", title: "登录", acceptance: [], source: "docs/archive/spec/02.md" },
    ],
  };
  // 喂进这次运行的原始材料（没有 rules，所以按形状认得出是材料）。
  outputs["wf-1:docs"] = {
    text: "目标端为 web 时可选启用 web3 能力。登录失败时显示「用户名或密码错误」。",
    origin: "docs/archive/spec/02.md",
  };
});

afterEach(() => {
  delete process.env.TP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function project() {
  return db.createProject("p", "https://example.com").id;
}
function kase(projectId: string, patch: Record<string, unknown>) {
  return db.createCase({ projectId, title: "t", priority: "P1", steps: [], sourceRunId: "wf-1", ...patch });
}

describe("which story a case points at", () => {
  it("pairs the case with its story and carries the acceptance criteria across", async () => {
    const p = project();
    kase(p, { title: "web 端显示 web3 选项", storyId: "US-01" });
    const rep = await tr.traceability(p);
    expect(rep.rows[0].storyTitle).toBe("新建项目");
    expect(rep.rows[0].acceptance).toEqual(["目标端为 web 时可选启用 web3 能力"]);
    expect(rep.orphans).toBe(0);
  });

  it("calls a case with no story an orphan", async () => {
    const p = project();
    kase(p, { storyId: "" });
    expect((await tr.traceability(p)).orphans).toBe(1);
  });

  it("calls a case pointing at a story the run never produced an orphan too", async () => {
    const p = project();
    kase(p, { storyId: "US-99" });
    const rep = await tr.traceability(p);
    expect(rep.rows[0].orphan).toBe(true);
    expect(rep.rows[0].storyTitle).toBeUndefined();
  });
});

describe("which stories have no case", () => {
  it("lists every story the run produced and counts the cases against each", async () => {
    const p = project();
    kase(p, { storyId: "US-01" });
    const rep = await tr.traceability(p);
    expect(rep.stories.map((s) => [s.storyId, s.cases])).toEqual([
      ["US-01", 1],
      ["US-02", 0],
    ]);
    expect(rep.uncovered).toBe(1);
  });
});

describe("what an assertion quotes", () => {
  it("finds quoted interface text in the material the run was given", async () => {
    const p = project();
    kase(p, { storyId: "US-02", expected: "页面显示「用户名或密码错误」" });
    const rep = await tr.traceability(p);
    expect(rep.rows[0].anchors).toEqual([
      { text: "用户名或密码错误", grounded: true, where: "material" },
    ]);
    expect(rep.ungrounded).toBe(0);
  });

  it("flags quoted text the material never promises — undocumented or invented, both worth seeing", async () => {
    const p = project();
    kase(p, { storyId: "US-02", expected: "状态变为「已停止」" });
    const rep = await tr.traceability(p);
    expect(rep.rows[0].anchors).toEqual([{ text: "已停止", grounded: false, where: undefined }]);
    expect(rep.ungrounded).toBe(1);
  });

  it("does not pass a case that quotes nothing — it has nothing to check, which is its own state", async () => {
    const p = project();
    kase(p, { storyId: "US-02", expected: "页面正常显示" });
    const row = (await tr.traceability(p)).rows[0];
    expect(row.unanchored).toBe(true);
    expect(row.anchors).toEqual([]);
  });

  it("does not call anything ungrounded when the run kept no material to check against", async () => {
    delete outputs["wf-1:docs"];
    const p = project();
    kase(p, { storyId: "US-02", expected: "状态变为「已停止」" });
    expect((await tr.traceability(p)).ungrounded).toBe(0);
  });

  /**
   * 判「查得到出处」要拿**喂进去的材料**比，不是整理之后的规格。
   *
   * 此前比的是 `spec` 节点的产物，而在现在的图里那已经是 `spec.compose` 的输出——一份被
   * 压缩和转述过的东西。材料里明明写着的一句界面文案，只要整理者换了说法，就会被判成
   * 「查不到出处」。这个检查因此系统性地高报，而高报的方向恰好最容易让人不再相信它。
   */
  it("材料里查得到就算有出处，哪怕整理后的规格把它转述掉了", async () => {
    outputs["wf-1:spec"] = {
      text: "登录失败会给出错误提示。",
      rules: [{ id: "R-01", text: "登录失败会给出错误提示", evidence: "" }],
    };
    const p = project();
    kase(p, { storyId: "US-02", expected: "页面显示「用户名或密码错误」" });
    const rep = await tr.traceability(p);
    expect(rep.rows[0].anchors[0]).toMatchObject({ grounded: true, where: "material" });
    delete outputs["wf-1:spec"];
  });

  it("只在整理后的规格里查到也算有出处，但要说清是哪一份——那说明材料里没有这句话", async () => {
    outputs["wf-1:spec"] = {
      text: "会话过期后显示「登录已失效」。",
      rules: [{ id: "R-01", text: "会话过期提示", evidence: "" }],
    };
    const p = project();
    kase(p, { storyId: "US-02", expected: "页面显示「登录已失效」" });
    const rep = await tr.traceability(p);
    expect(rep.rows[0].anchors[0]).toMatchObject({ grounded: true, where: "spec" });
    delete outputs["wf-1:spec"];
  });

  it("空白差异不算差异：换行和缩进不该让一句原话查不到", async () => {
    outputs["wf-1:docs"] = { text: "登录失败时显示\n  「用户名或密码错误」。", origin: "d.md" };
    const p = project();
    kase(p, { storyId: "US-02", expected: "页面显示「用户名或密码错误」" });
    expect((await tr.traceability(p)).ungrounded).toBe(0);
  });

  it("带占位符的引文不算可查的文案——因为正确地参数化了凭证而扣分是说不通的", () => {
    expect(tr.literalsIn('页面显示 "Welcome, ${env.VALID_USERNAME}"')).toEqual([]);
    // 同一句里没有占位符的那部分照常要查。
    expect(tr.literalsIn('显示 "Welcome, ${env.USER}" 与 "Your dashboard is ready."')).toEqual([
      "Your dashboard is ready.",
    ]);
  });

  it("ignores bare numbers in quotes, which claim nothing about the interface", () => {
    expect(tr.literalsIn('计数变为 "12"')).toEqual([]);
    expect(tr.literalsIn('显示 "12 件商品"')).toEqual(["12 件商品"]);
  });
});
