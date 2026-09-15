import { validateRulePack, type ProductRulePack } from "@testpilot/harness-testing/domain";
import { db } from "./db.js";
import { runLedger } from "./runService.js";
import { LedgerError } from "./runLedger.js";

/**
 * 项目级的产品规则包（docs/v3/24 §19）。
 *
 * 在这之前规则包**没有任何管理**：每次新建运行在表单里贴一份 JSON，存进那次运行的账本
 * （`knowledge/rulepack/<id>`），跨运行不复用、列不出来、改不了、也比不了两版的差异。
 * 而它已经是这个产品最主要的领域资产——探索目标、`requires`/`provides`、`fill` 的值、
 * 行业禁点词表，这一轮全往里搬。**同一个项目的两次运行可以用着不同的包而没人拦**，
 * 两臂对照最怕的就是这个。
 *
 * 一份包按内容哈希存一版：同样的内容重复上传是幂等的，改一个字就是新的一版。
 * 哪次运行钉在哪一版上，从账本里反查（运行里那条修订记着 `rulePackHash`）。
 */
export interface RulePackVersion {
  id: string;
  projectId: string;
  packId: string;
  version: string;
  hash: string;
  createdAt: string;
  counts: { modules: number; features: number; rules: number; targets: number };
}

function table() {
  db.exec(`CREATE TABLE IF NOT EXISTS rule_packs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, packId TEXT NOT NULL, version TEXT NOT NULL,
    hash TEXT NOT NULL, json TEXT NOT NULL, createdAt TEXT NOT NULL,
    UNIQUE(projectId, packId, hash))`);
  return db;
}
const countsOf = (p: ProductRulePack) => ({ modules: p.modules.length, features: p.features.length, rules: p.rules.length, targets: p.targets.length });
const rowToVersion = (r: { id: string; projectId: string; packId: string; version: string; hash: string; json: string; createdAt: string }): RulePackVersion =>
  ({ id: r.id, projectId: r.projectId, packId: r.packId, version: r.version, hash: r.hash, createdAt: r.createdAt,
     counts: countsOf(JSON.parse(r.json) as ProductRulePack) });

export function listRulePacks(projectId: string): Array<RulePackVersion & { usedByRuns: string[] }> {
  const rows = table().prepare("SELECT * FROM rule_packs WHERE projectId=? ORDER BY createdAt DESC").all(projectId) as never[];
  const used = usageByHash(projectId);
  return (rows as Array<Parameters<typeof rowToVersion>[0]>).map((r) => ({ ...rowToVersion(r), usedByRuns: used.get(r.hash) ?? [] }));
}

/** 哪一版被哪些运行用过。运行里那条 `knowledge/rulepack/*` 修订记着哈希，从那儿反查。 */
function usageByHash(projectId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const l = runLedger();
  const rows = l.db.prepare("SELECT json FROM artifact_revisions").all() as Array<{ json: string }>;
  for (const row of rows) {
    const rev = JSON.parse(row.json) as { projectId?: string; runId?: string; name?: string };
    if (rev.projectId !== projectId || !rev.name?.startsWith("knowledge/rulepack/")) continue;
    try {
      const content = l.readRevision((JSON.parse(row.json) as { id: string }).id, projectId).content as { rulePackHash?: string };
      if (!content.rulePackHash || !rev.runId) continue;
      const list = out.get(content.rulePackHash) ?? [];
      if (!list.includes(rev.runId)) list.push(rev.runId);
      out.set(content.rulePackHash, list);
    } catch { /* 读不回来的旧修订不该让这一页打不开 */ }
  }
  return out;
}

export function readRulePack(projectId: string, hash: string): ProductRulePack {
  const row = table().prepare("SELECT json FROM rule_packs WHERE projectId=? AND hash=?").get(projectId, hash) as { json: string } | undefined;
  if (!row) throw new LedgerError(404, "rule_pack_not_found");
  return JSON.parse(row.json) as ProductRulePack;
}

/** 上传一版。校验不过就整份拒收，错误带 jsonPointer——那正是编辑器要的东西。 */
export function saveRulePack(projectId: string, raw: unknown): RulePackVersion & { created: boolean } {
  const v = validateRulePack(raw);
  if (!v.ok) throw new LedgerError(400, `invalid_rule_pack:${JSON.stringify(v.errors.slice(0, 8))}`);
  const existing = table().prepare("SELECT * FROM rule_packs WHERE projectId=? AND packId=? AND hash=?")
    .get(projectId, v.pack.id, v.hash) as Parameters<typeof rowToVersion>[0] | undefined;
  if (existing) return { ...rowToVersion(existing), created: false };
  // id 带上项目：同一份包装进两个项目是两行。
  const row = { id: `rp-${projectId}-${v.hash.slice(0, 12)}`, projectId, packId: v.pack.id, version: v.pack.version,
    hash: v.hash, json: JSON.stringify(v.pack), createdAt: new Date().toISOString() };
  table().prepare("INSERT INTO rule_packs (id,projectId,packId,version,hash,json,createdAt) VALUES (@id,@projectId,@packId,@version,@hash,@json,@createdAt)").run(row);
  return { ...rowToVersion(row), created: true };
}

/** 删一版。**用过的那一版不许删**：运行的回执指着它，删了之后那次运行就说不清自己按什么跑的。 */
export function deleteRulePack(projectId: string, hash: string): void {
  if ((usageByHash(projectId).get(hash) ?? []).length) throw new LedgerError(409, "rule_pack_in_use");
  table().prepare("DELETE FROM rule_packs WHERE projectId=? AND hash=?").run(projectId, hash);
}

/** 这个项目当前那一份（最新上传的一版）。新建运行没显式给包时用它。 */
export function currentRulePack(projectId: string): ProductRulePack | undefined {
  const row = table().prepare("SELECT json FROM rule_packs WHERE projectId=? ORDER BY createdAt DESC LIMIT 1").get(projectId) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as ProductRulePack) : undefined;
}

/**
 * 这次运行**绑定的**规则包（账本里最新那条 `knowledge/rulepack/*`）；没绑定返回 undefined。
 * 执行守卫、门禁、验收准则索引从这里取这个产品特有的词——不是从代码里。
 */
/**
 * 把一份规则包冻结绑定进这次运行（`knowledge/rulepack/<id>`）。Web 建的运行和宿主登记的运行走同一个写法，
 * 否则宿主运行的 `boundRulePack` 是空的，项目的行业词表到不了验收索引、门禁与守卫。
 */
export function bindRulePack(runId: string, projectId: string, pack: ProductRulePack, hash: string, principal: { kind: "system" | "agent"; id: string }): void {
  runLedger().putRevision({ projectId, runId, name: `knowledge/rulepack/${pack.id}`, kind: "report",
    content: { name: `rulepack/${pack.id}`, roles: ["source", "stories", "cases", "gate"], trust: "user-provided", executable: false, rulePack: pack, rulePackHash: hash } }, principal as never);
}

/** 项目当前那份规则包绑定进运行；项目没有就什么都不写。 */
export function bindCurrentRulePack(runId: string, projectId: string, principal: { kind: "system" | "agent"; id: string }): void {
  const current = currentRulePack(projectId);
  if (!current) return;
  const v = validateRulePack(current);
  if (v.ok) bindRulePack(runId, projectId, v.pack, v.hash, principal);
}

export function boundRulePack(runId: string, projectId: string): ProductRulePack | undefined {
  const l = runLedger();
  const rev = l.listRevisions(projectId, runId).filter((r) => r.name.startsWith("knowledge/rulepack/")).sort((a, b) => a.revision - b.revision).at(-1);
  if (!rev) return undefined;
  const v = validateRulePack((l.readRevision(rev.id, projectId).content as { rulePack?: unknown }).rulePack);
  return v.ok ? v.pack : undefined;
}
