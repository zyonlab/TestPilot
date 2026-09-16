import { it, expect } from "vitest";
import { buildExportFiles } from "../src/export.js";

/**
 * 导出的 manifest 要带回得去的线索（docs/v3/history/20 切片 7「失败证据可追溯」）。
 *
 * 交出去的工程里一条测试红了，拿着它要能回到产生它的那次运行。板上的 id 在客户手里
 * 是个孤立字符串——没有 run 的指针就追不回去。
 */
const project = { id: "p1", name: "Demo", targetUrl: "https://example.test/", createdAt: "", updatedAt: "" } as never;
const kase = (over: Record<string, unknown> = {}) => ({
  id: "tc-1", projectId: "p1", title: "切到逐仓", priority: "P0", type: "functional",
  precondition: "", steps: [{ order: 1, text: "点击 Isolated" }], postSteps: [], expected: "接口返回 isolated",
  oracle: { kind: "text", value: "Isolated" }, tier: 1, quarantined: false, degraded: false,
  createdAt: "", ...over,
}) as never;

it("manifest 带上来源 run 与故事，判据逐字节等于板上的那一份", () => {
  const files = buildExportFiles(project, [kase({ sourceRunId: "run-abc", storyId: "S-TP-09" })]);
  const manifest = JSON.parse(files["testpilot-manifest.json"]!) as { cases: Array<Record<string, unknown>> };
  expect(manifest.cases[0]).toMatchObject({ id: "tc-1", sourceRunId: "run-abc", storyId: "S-TP-09" });
  expect(manifest.cases[0]!.oracle).toEqual({ kind: "text", value: "Isolated" });
});

it("没有来源的用例不硬塞一个空指针——「没说」和「说了是空」不是一回事", () => {
  const files = buildExportFiles(project, [kase()]);
  const manifest = JSON.parse(files["testpilot-manifest.json"]!) as { cases: Array<Record<string, unknown>> };
  expect(manifest.cases[0]).not.toHaveProperty("sourceRunId");
  expect(manifest.cases[0]).not.toHaveProperty("storyId");
});

it("同一批用例导出两次逐字节一致——重复集成不该产生差异", () => {
  const cases = [kase({ sourceRunId: "run-abc" })];
  expect(buildExportFiles(project, cases)).toEqual(buildExportFiles(project, cases));
});
