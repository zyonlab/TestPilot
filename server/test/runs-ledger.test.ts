import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

/**
 * 执行台账的契约：一个项目跑过的每一次执行都要能在这里看到，而三种来源不能被读成一件事。
 *
 * 这页此前只列套件批次，于是一个用例只被修复环跑过的项目打开是空白——而空白读起来是
 * 「从来没跑过」，那是假的。放宽之后新的风险是反过来的：把候选用例的试跑和已批准用例的
 * 执行混成一个通过率。所以来源要能分开，这组测试守的就是这两件事。
 */

const dir = resolve(tmpdir(), `tp-ledger-${process.pid}`);
let db: typeof import("../src/db.js");

beforeEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  process.env.TP_DATA_DIR = dir;
  vi.resetModules();
  db = await import("../src/db.js");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const boardRun = (projectId: string, caseId: string, over: Record<string, unknown> = {}) =>
  db.createRun({
    caseId,
    caseTitle: "登录成功",
    projectId,
    priority: "P0",
    status: "passed",
    durationMs: 1000,
    startedAt: new Date().toISOString(),
    logs: [],
    ...over,
  } as never);

describe("执行台账", () => {
  it("列出工作流里跑过的候选用例——它没有看板用例可以 join", () => {
    const p = db.createProject("走一遍", "http://localhost:3000");
    db.createRun({
      caseId: "S-01-1-登录页标题",
      caseTitle: "验证登录页面标题",
      projectId: p.id,
      priority: "P2",
      status: "passed",
      durationMs: 45100,
      startedAt: new Date().toISOString(),
      logs: [],
      origin: "workflow",
      wfRunId: "wf-mt2xy9j6",
    } as never);

    const rows = db.listRunsByProject(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("workflow");
    expect(rows[0].wfRunId).toBe("wf-mt2xy9j6");
  });

  it("套件和单跑分得开：批次里的算套件，其余算单跑", () => {
    const p = db.createProject("走一遍", "http://localhost:3000");
    const c = db.createCase({ projectId: p.id, title: "登录成功", priority: "P0" } as never);
    const inSuite = boardRun(p.id, c.id);
    boardRun(p.id, c.id);

    const batch = db.createBatch(p.id, "回归");
    db.addBatchRun({
      batchId: batch.id,
      caseId: c.id,
      caseTitle: c.title,
      runId: inSuite.id,
      status: "passed",
      attempts: 1,
      healed: false,
    } as never);

    const byOrigin = Object.fromEntries(
      db.listRunsByProject(p.id).map((r) => [r.id, r.origin]),
    );
    expect(byOrigin[inSuite.id]).toBe("suite");
    expect(Object.values(byOrigin).filter((o) => o === "case")).toHaveLength(1);
  });

  it("不串项目：一个项目的台账里没有另一个项目的执行", () => {
    const a = db.createProject("A", "http://a.test");
    const b = db.createProject("B", "http://b.test");
    boardRun(a.id, "tc-a", { origin: "workflow", wfRunId: "wf-a" });
    boardRun(b.id, "tc-b", { origin: "workflow", wfRunId: "wf-b" });

    expect(db.listRunsByProject(a.id).map((r) => r.wfRunId)).toEqual(["wf-a"]);
  });

  it("修复环同一条用例跑三次就是三行——只留最后一次会抹掉这页存在的理由", () => {
    const p = db.createProject("走一遍", "http://localhost:3000");
    for (const status of ["failed", "failed", "passed"] as const)
      db.createRun({
        caseId: "S-02-2-登录失败",
        caseTitle: "登录失败后 url 不变",
        projectId: p.id,
        priority: "P2",
        status,
        durationMs: 3000,
        startedAt: new Date().toISOString(),
        logs: [],
        origin: "workflow",
        wfRunId: "wf-1",
      } as never);

    const rows = db.listRunsByProject(p.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === "passed")).toHaveLength(1);
  });
});
