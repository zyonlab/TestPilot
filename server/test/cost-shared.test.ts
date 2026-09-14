import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** T-21 验收 ①：端点与脚本 `--json` 逐字段一致。同一份聚合、同一个库；这里用真库钉住。 */
const dir = resolve(tmpdir(), `tp-cost-${process.pid}`);
let db: typeof import("../src/db.js");
let cost: typeof import("../src/cost.js");

beforeEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.TP_DATA_DIR = dir;
  db = await import("../src/db.js");
  cost = await import("../src/cost.js");
});
afterEach(() => {
  delete process.env.TP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("成本账：端点 = 脚本", () => {
  it("同一个项目、同一个 last，两边的 cases 与 totals 相等", () => {
    const p = db.createProject("cost-p", "https://x.example");
    const c = db.createCase({ projectId: p.id, title: "案例", steps: [{ text: "x" }] });
    for (let i = 0; i < 3; i++) {
      const run = db.createRun({ caseId: c.id, caseTitle: c.title, projectId: p.id, priority: "P0", status: i === 1 ? "failed" : "passed", durationMs: 1000 * (i + 1), startedAt: new Date(Date.now() - i * 1000).toISOString(), logs: [], screenshots: [], oracle: [], infraError: false, ...(i === 1 ? { failKind: "assert" } : {}) } as never);
      db.updateRunResults(run.id, { spend: { modelCalls: i, modelMs: 10 * i, tokens: 100 * i, cacheHits: 1, cacheMisses: 0, cacheStale: 0, attribution: "runner", phases: { launchMs: 1, loginMs: 2, settleMs: 3, stepsMs: 4, assertMs: 5, teardownMs: 6 } } } as never);
    }
    writeFileSync(resolve(dir, "degrades.jsonl"), JSON.stringify({ at: "t", caseId: c.id, actor: "agent", blocked: true, findings: ["x"] }) + "\n");
    const viaEndpoint = cost.projectCost(p.id, 2);
    const viaScript = JSON.parse(execFileSync(process.execPath, [resolve(__dirname, "../../scripts/cost-report.mjs"), "--project", p.id, "--last", "2", "--json"], { env: { ...process.env, TP_DATA_DIR: dir }, encoding: "utf8" }));
    expect(viaEndpoint.cases).toEqual(viaScript.cases);
    expect(viaEndpoint.totals).toEqual(viaScript.totals);
    expect(viaEndpoint.cases[0].failures).toEqual({ infra: 0, locate: 0, assert: 1, unknown: 0 });
    expect(viaEndpoint.cases[0].degraded).toEqual({ total: 1, blocked: 1 });
  });
});
