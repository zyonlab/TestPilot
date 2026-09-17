import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 2026-09-15：领域内容一律是项目数据。这里钉四件事——
 * 领域参考按版本存、运行开始时冻结绑定、没有就没有；环境画像读写得回来；
 * 行业动作词来自规则包；「允许不可逆」是环境的属性、禁止名单优先。
 */
let dir: string, projectId: string;
let db: typeof import("../src/db.js"), refs: typeof import("../src/domainReferences.js"), service: typeof import("../src/runService.js");
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-domain-data-")); vi.stubEnv("TP_DATA_DIR", dir);
  vi.stubEnv("MIDSCENE_MODEL_NAME", "fixture-executor"); vi.stubEnv("MIDSCENE_MODEL_BASE_URL", "https://executor.test/v1"); vi.stubEnv("MIDSCENE_MODEL_API_KEY", "fixture-key");
  db = await import("../src/db.js"); refs = await import("../src/domainReferences.js"); service = await import("../src/runService.js");
  projectId = db.createProject("Domain data fixture", "http://127.0.0.1:9877").id;
});
afterAll(() => { service.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("领域参考是项目数据", () => {
  it("没有就没有：新项目没有当前版本，绑定什么都不写", () => {
    expect(refs.currentDomainReference(projectId)).toBeUndefined();
    const { runId } = service.registerHostRun(projectId, { runtime: "codex", externalId: "no-ref", idempotencyKey: "no-ref", materials: [{ name: "m.md", text: "# 材料\n\n## 一段\n内容\n" }] });
    expect(refs.boundDomainReference(runId, projectId)).toBe("");
  });

  it("按内容存版本：同样的内容是同一版，空的拒收", () => {
    const a = refs.saveDomainReference(projectId, { text: "- 空标题提交会被拒绝，列表不多出一行" });
    expect(a.created).toBe(true);
    expect(refs.saveDomainReference(projectId, { text: "- 空标题提交会被拒绝，列表不多出一行\n" }).created).toBe(false);
    expect(() => refs.saveDomainReference(projectId, { text: "  " })).toThrow("domain_reference_empty");
    expect(refs.listDomainReferences(projectId)).toHaveLength(1);
  });

  it("同一份参考装进另一个项目是另一行，不撞主键", () => {
    const other = db.createProject("Domain data fixture 2", "http://127.0.0.1:9878").id;
    expect(refs.saveDomainReference(other, { text: "- 空标题提交会被拒绝，列表不多出一行" }).created).toBe(true);
    expect(refs.listDomainReferences(other)).toHaveLength(1);
  });

  it("运行登记时冻结当前那一版；用过的版本不能删", () => {
    const { runId } = service.registerHostRun(projectId, { runtime: "codex", externalId: "with-ref", idempotencyKey: "with-ref", materials: [{ name: "m.md", text: "# 材料\n\n## 一段\n内容\n" }] });
    expect(refs.boundDomainReference(runId, projectId)).toContain("空标题提交会被拒绝");
    const hash = refs.currentDomainReference(projectId)!.hash;
    expect(refs.listDomainReferences(projectId)[0]!.usedByRuns).toContain(runId);
    expect(() => refs.deleteDomainReference(projectId, hash)).toThrow("domain_reference_in_use");
  });
});

describe("环境画像", () => {
  it("前提名、注入钱包、允许不可逆写得进读得回，默认都是关的", () => {
    const plain = db.upsertEnvironment({ projectId, name: "plain", baseUrl: "http://127.0.0.1:9877" });
    expect(db.resolveEnvironment(projectId, "plain")).toMatchObject({ injectWallet: false });
    expect(plain.capabilities).toBeUndefined();
    db.upsertEnvironment({ projectId, name: "plain", capabilities: ["session", "wallet-session"], injectWallet: true });
    expect(db.resolveEnvironment(projectId, "plain")).toMatchObject({ capabilities: ["session", "wallet-session"], injectWallet: true });
    // 只改别的字段时，已存的画像不被冲掉。
    db.upsertEnvironment({ projectId, name: "plain", baseUrl: "http://127.0.0.1:9878" });
    expect(db.resolveEnvironment(projectId, "plain")).toMatchObject({ injectWallet: true, baseUrl: "http://127.0.0.1:9878" });
  });
});

describe("行业词来自规则包，不来自代码", () => {
  it("验收准则：「平仓」没有规则包的词就不算动作", async () => {
    const { acceptanceIsActionable } = await import("../src/acceptanceIndex.js");
    const ac = "Given 有一笔持仓 / When 用户平仓 / Then 持仓表不再列出它";
    expect(acceptanceIsActionable(ac)).toBe(false);
    expect(acceptanceIsActionable(ac, ["平仓"])).toBe(true);
    // 通用动作照旧认。
    expect(acceptanceIsActionable("Given 列表页 / When 用户点击「新建」 / Then 出现表单")).toBe(true);
  });

  it("执行守卫：不可逆步骤默认放行；运营方禁止名单仍然优先", async () => {
    const { guardRun } = await import("../src/executionPolicy.js");
    const { config } = await import("../src/procs.js");
    expect(() => guardRun("http://127.0.0.1:9877/", ["删除这个项目"])).not.toThrow();
    const denied = config.guard.denyHosts[0];
    if (denied) expect(() => guardRun(`https://${denied}/`, ["查看首页"])).toThrow(/denyHosts/);
  });
});
