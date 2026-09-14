import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 项目级规则包（docs/v3/24 §19）：按内容哈希存版本、用过的不许删、新建运行默认用最新一版。
 * 在这之前它只能在新建运行的表单里贴一次，躺在那次运行里——列不出、改不了、比不了。
 */
let dir: string, project: string, packs: typeof import("../src/rulePacks.js"), db: typeof import("../src/db.js");
const RAW = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/perp-lab/rules.json"), "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-rulepacks-"));
  vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://f.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "k");
  db = await import("../src/db.js"); packs = await import("../src/rulePacks.js");
  project = db.createProject("packs", "http://127.0.0.1:5391/").id;
});
afterAll(async () => { (await import("../src/runService.js")).runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("同样的内容重复上传是同一版；改一个字是新的一版", () => {
  const a = packs.saveRulePack(project, RAW);
  expect(a.created).toBe(true);
  expect(packs.saveRulePack(project, RAW).created).toBe(false);
  const b = packs.saveRulePack(project, { ...RAW, version: `${String(RAW.version)}-next` });
  expect(b.created).toBe(true);
  expect(b.hash).not.toBe(a.hash);
  expect(packs.listRulePacks(project)).toHaveLength(2);
});

it("列出来的每一版都带着数量与用过它的运行", () => {
  const [first] = packs.listRulePacks(project);
  expect(first!.counts.targets).toBeGreaterThan(0);
  expect(first!.usedByRuns).toEqual([]);
});

it("校验不过整份拒收，错误带 jsonPointer——那正是写包的人要看的", () => {
  expect(() => packs.saveRulePack(project, { ...RAW, targets: [{ id: "T-X", featureId: "nope", match: { label: ["^X$"] } }] }))
    .toThrow(/invalid_rule_pack/);
});

it("项目当前那一版 = 最新上传的一版", () => {
  const current = packs.currentRulePack(project);
  expect(current!.version).toContain("-next");
});

it("没用过的版本能删", () => {
  const before = packs.listRulePacks(project).length;
  packs.deleteRulePack(project, packs.listRulePacks(project)[0]!.hash);
  expect(packs.listRulePacks(project)).toHaveLength(before - 1);
});
