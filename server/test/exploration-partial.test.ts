import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 探索是九个节点里唯一一个「中途挂 = 全丢」的，而它同时是最长的一个
 * （一次 187,669 字的材料要几十分钟加一次钱包会话）。探索器现在每采一屏落一次半成品，
 * 服务端在失败路径上把它捡回来——已经花掉的钱不白花。
 *
 * 这不是断点续跑：不会从第 18 屏接着探。测的是「捡得回来」和「捡不回来时如实抛」。
 */
describe("探索中途失败时捡回已采到的屏", () => {
  let dir: string;
  let ops: typeof import("../src/workflowOps.js");
  let db: typeof import("../src/db.js");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-partial-"));
    vi.stubEnv("TP_DATA_DIR", dir);
    db = await import("../src/db.js");
    ops = await import("../src/workflowOps.js");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  // 写的时候用**探索器那一侧的函数**算落点：两侧共用同一个函数，这个接缝就错不开。
  const writePartial = async (projectId: string, body: unknown) => {
    const { partialObservationPath } = await import("@testpilot/harness-testing/exec");
    const path = partialObservationPath(db.ARTIFACT_DIR, `observe-${projectId}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  };

  it("有材料就捡回来，并说清楚它只到第几屏", async () => {
    await writePartial("p1", { partial: true, url: "https://x.test/", screens: 17, notes: "===== 第 1 屏 =====\n看到了东西" });
    const got = ops.readPartialObservation("p1");
    expect(got).toMatchObject({ screens: 17, url: "https://x.test/" });
    expect(got!.notes).toContain("看到了东西");
    // 停止原因要说人话：下游读到的是一份 17 屏的材料，不是 20 屏的。
    expect(String(got!.stoppedBecause)).toContain("17");
    // 半成品里没有状态图——给 undefined 而不是编一个空图，否则下游以为这产品只有一屏。
    expect(got!.graph).toBeUndefined();
  });

  it("材料是空的就当作没有——宁可如实抛出原来的错", async () => {
    await writePartial("p2", { partial: true, screens: 3, notes: "   " });
    expect(ops.readPartialObservation("p2")).toBeUndefined();
  });

  it("文件不存在、或者是半个 JSON，都当作没有", async () => {
    expect(ops.readPartialObservation("never-explored")).toBeUndefined();
    const { partialObservationPath } = await import("@testpilot/harness-testing/exec");
    const path = partialObservationPath(db.ARTIFACT_DIR, "observe-p3");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"notes":"半个');
    expect(ops.readPartialObservation("p3")).toBeUndefined();
  });
});

/**
 * `workflowCheckpoint` 的节点清单原来漏了 `source` 与 `modules`：一次在 modules 上失败的
 * 运行，`next` 会指向 `stories`——resume 把模块节点整个跳过去，而下游所有单元都按模块树切。
 *
 * 但这两个是有条件的：宿主注册的运行材料在注册时就交了，根本没有 source 节点。
 * 所以判据是「走过、而且没走完」，不是「没 done 就回到它」——第一版写成后者，
 * `run-routes` 的那条测试当场红了，对的。
 */
describe("checkpoint 的下一个节点", () => {
  const pick = (states: Array<{ node: string; phase: string }>) => {
    const conditional = new Set(["source", "modules"]);
    const stages = ["source", "modules", "instructions", "stories", "cases", "gate", "finalize"];
    const done = (s: string) => states.some((x) => x.node === s && x.phase === "done");
    const touched = (s: string) => states.some((x) => x.node === s);
    return stages.find((s) => (conditional.has(s) ? touched(s) && !done(s) : !done(s))) ?? "finalize";
  };

  it("走过 modules 但没走完 → 回到 modules", () => {
    expect(pick([{ node: "source", phase: "done" }, { node: "modules", phase: "failed" }])).toBe("modules");
  });

  it("从没走过 source 的宿主运行 → 不会被送回一个它没有的节点", () => {
    expect(pick([{ node: "instructions", phase: "done" }, { node: "stories", phase: "done" }])).toBe("cases");
  });

  it("探索没跑完 → 回到 source", () => {
    expect(pick([{ node: "source", phase: "running" }])).toBe("source");
  });

  it("必经节点没走过就是没走完", () => {
    expect(pick([{ node: "source", phase: "done" }, { node: "modules", phase: "done" }])).toBe("instructions");
  });
});
