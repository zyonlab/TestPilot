import { it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

/**
 * 工作流执行要落成运行记录并立视觉基线（docs/v3/23 §17）。
 *
 * 在此之前 `runs` 表只被旧的单用例路径写，界面上「待审批基线」那一页对工作流
 * 永远是空的——执行明明每步都截了图，只是没人把它们接到基线上。
 */
let dir: string, db: typeof import("../src/db.js"), vb: typeof import("../src/visualBaseline.js");
const png = (r: number, g: number, b: number) => {
  const p = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; }
  return PNG.sync.write(p);
};
/** 只改一个像素：16 个像素里改 1 个 = 6.25%，用来测阈值本身而不是测 0/100。 */
const onePixelOff = (r: number, g: number, b: number) => {
  const p = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; }
  p.data[0] = 255 - r; p.data[1] = 255 - g; p.data[2] = 255 - b;
  return PNG.sync.write(p);
};
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-wfbl-"));
  vi.stubEnv("TP_DATA_DIR", dir);
  db = await import("../src/db.js");
  vb = await import("../src/visualBaseline.js");
  for (const d of ["baselines", "current", "diff"]) mkdirSync(join(db.ARTIFACT_DIR, d), { recursive: true });
});
afterAll(() => { db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("第一次跑立基线，第二次同图算 match，换了图算 diff 并进待审批", () => {
  const p = db.createProject("wf-bl", "http://localhost").id;
  const c = db.createCase({ projectId: p, title: "一条工作流用例" });
  const first = vb.processVisual(c.id, "exec-1", [png(10, 10, 10)]);
  expect(first[0]!.status).toBe("new_baseline");
  expect(db.listBaselines(c.id)).toHaveLength(1);

  const same = vb.processVisual(c.id, "exec-2", [png(10, 10, 10)]);
  expect(same[0]!.status).toBe("match");
  expect(same[0]!.mismatchPct).toBe(0);

  const changed = vb.processVisual(c.id, "exec-3", [png(200, 10, 10)]);
  expect(changed[0]!.status).toBe("diff");
  expect(changed[0]!.mismatchPct).toBeGreaterThan(vb.VISUAL_THRESHOLD);

  // 落一条工作流来源的运行，带上这次的视觉结果——待审批清单就是从这里读的。
  const run = db.createRun({ caseId: c.id, caseTitle: c.title, projectId: p, priority: "P1", status: "failed",
    durationMs: 1, startedAt: new Date().toISOString(), logs: [], screenshots: [], origin: "workflow", wfRunId: "run-x" } as never);
  db.updateRunResults(run.id, { visual: changed });
  const pending = db.listRunsByProject(p).find((r) => r.id === run.id)!;
  expect(pending.origin).toBe("workflow");
  expect((pending.visual ?? []).some((v) => v.status === "diff")).toBe(true);
});

it("基线按板上用例的 id 立：改一版就是新的一条，不继承上一版的截图", () => {
  const p = db.createProject("wf-bl-2", "http://localhost").id;
  const v1 = db.createCase({ projectId: p, id: "tc-rev-aaa", title: "第一版" });
  const v2 = db.createCase({ projectId: p, id: "tc-rev-bbb", title: "第二版" });
  vb.processVisual(v1.id, "e1", [png(1, 1, 1)]);
  expect(vb.processVisual(v2.id, "e2", [png(250, 250, 250)])[0]!.status).toBe("new_baseline");
  expect(db.listBaselines(v1.id)).toHaveLength(1);
  expect(db.listBaselines(v2.id)).toHaveLength(1);
});

it("视觉阈值跟着被测对象走：实时行情页那点漂移不该每次都进待审批", () => {
  const p = db.createProject("wf-bl-3", "http://localhost").id;
  const c = db.createCase({ projectId: p, title: "行情页" });
  vb.processVisual(c.id, "e1", [png(100, 100, 100)]);
  // 16 个像素里改 1 个 = 6.25%：默认 0.5% 判 diff，给这个被测对象配 10% 就判 match。
  const slight = onePixelOff(100, 100, 100);
  const d = vb.processVisual(c.id, "e2", [slight])[0]!;
  expect(d.status).toBe("diff");
  expect(d.mismatchPct).toBeCloseTo(6.25, 1);
  expect(vb.processVisual(c.id, "e3", [slight], 10)[0]!.status).toBe("match");
});

it("阈值 0 有意义——逐像素必须相同，不能被当成「没配」", () => {
  const p = db.createProject("wf-bl-4", "http://localhost").id;
  const c = db.createCase({ projectId: p, title: "静态页" });
  vb.processVisual(c.id, "e1", [png(0, 0, 0)]);
  expect(vb.processVisual(c.id, "e2", [png(0, 0, 0)], 0)[0]!.status).toBe("match");
  expect(vb.processVisual(c.id, "e3", [png(255, 255, 255)], 0)[0]!.status).toBe("diff");
});
