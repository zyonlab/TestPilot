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

  const attempt={attemptId:'91d6725e-d5d2-4f10-b274-9d8e4b87bb8d',projectId:'p1',runId:'run1',entryUrl:'https://x.test/',scopeHash:'scope1',startedAt:'2026-09-23T00:00:00.000Z'};
  const body=()=>({partial:true,sourceAttempt:attempt,at:'2026-09-23T00:01:00.000Z',url:attempt.entryUrl,screens:17,notes:'===== 第 1 屏 =====\n看到了东西'});
  const writePartial = async (value: unknown, execId=`observe-${attempt.attemptId}`) => {
    const { partialObservationPath } = await import('@testpilot/harness-testing/exec');
    const path = partialObservationPath(db.ARTIFACT_DIR, execId);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value==='string'?value:JSON.stringify(value));
    return path;
  };
  it('only salvages material captured by this exact attempt, retaining provenance and failed stop', async () => {
    await writePartial(body());
    expect(ops.readPartialObservation(attempt)).toMatchObject({screens:17,url:attempt.entryUrl,sourceAttempt:attempt,stopped:{kind:'failed'}});
    expect(ops.readPartialObservation(attempt)?.graph).toBeUndefined();
  });
  it.each(['attemptId','runId','projectId','entryUrl','scopeHash','startedAt'] as const)('rejects mismatched %s, including another simultaneous attempt', async field => {
    await writePartial({...body(),sourceAttempt:{...attempt,[field]:field==='attemptId'?'350b241c-6f42-4f7e-8029-87178fd9e172':field==='startedAt'?'2026-09-22T00:00:00.000Z':'other'}});
    expect(ops.readPartialObservation(attempt)).toBeUndefined();
  });
  it.each(['legacy','empty','bad-json','no-screens','older','wrong-url','not-partial'])('rejects %s artifacts',async fault=>{
    const b:Record<string,unknown>=body();
    if(fault==='legacy')delete b.sourceAttempt;
    if(fault==='empty')b.notes='  ';
    if(fault==='no-screens')b.screens=0;
    if(fault==='older')b.at='2026-09-22T00:00:00.000Z';
    if(fault==='wrong-url')b.url='https://other.test/';
    if(fault==='not-partial')b.partial=false;
    await writePartial(fault==='bad-json'?'{"notes":"half':b);
    expect(ops.readPartialObservation(attempt)).toBeUndefined();
  });
  it('first capture failure cannot pick an older project file; original history is untouched',async()=>{
    const {readFileSync}=await import('node:fs');
    const path=await writePartial(body(),'observe-p1'),before=readFileSync(path,'utf8');
    expect(ops.readPartialObservation({...attempt,attemptId:'ccbe53ca-d8d4-45b0-b0bd-4d0c005212d4'})).toBeUndefined();
    expect(readFileSync(path,'utf8')).toBe(before);
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
