import { createHash } from "node:crypto";
import { db } from "./db.js";
import { runLedger } from "./runService.js";
import { LedgerError } from "./runLedger.js";

/**
 * 项目级的**领域参考**：这个产品有哪些不变量、用例可以拿什么去反驳它。
 *
 * 和规则包一个待遇：按内容哈希存版本，用户在「领域参考」页聊出来（`fieldDraft.ts` 的
 * `domainReference`）或上传；运行开始时把当前那一版冻结绑定进账本（`knowledge/domain-reference`），
 * 下游只认绑定的那份。**没有就没有**——代码不替任何产品补一段。
 */
export interface DomainReferenceVersion {
  id: string;
  projectId: string;
  hash: string;
  title: string;
  chars: number;
  createdAt: string;
}

const MAX_CHARS = 60_000;
const REVISION_NAME = "knowledge/domain-reference";

function table() {
  db.exec(`CREATE TABLE IF NOT EXISTS domain_references (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL,
    text TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(projectId, hash))`);
  return db;
}
type Row = { id: string; projectId: string; hash: string; title: string; text: string; createdAt: string };
const toVersion = (r: Row): DomainReferenceVersion =>
  ({ id: r.id, projectId: r.projectId, hash: r.hash, title: r.title, chars: r.text.length, createdAt: r.createdAt });
const hashOf = (text: string) => createHash("sha256").update(text.trim()).digest("hex");

/** 哪一版被哪些运行绑定过——从账本里那条 `knowledge/domain-reference` 修订反查。 */
function usageByHash(projectId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const l = runLedger();
  for (const r of l.listRevisions(projectId)) {
    if (r.name !== REVISION_NAME) continue;
    try {
      const hash = (l.readRevision(r.id, projectId).content as { domainReferenceHash?: string }).domainReferenceHash;
      if (!hash) continue;
      const list = out.get(hash) ?? [];
      if (!list.includes(r.runId)) list.push(r.runId);
      out.set(hash, list);
    } catch { /* 读不回来的旧修订不该让这一页打不开 */ }
  }
  return out;
}

export function listDomainReferences(projectId: string): Array<DomainReferenceVersion & { usedByRuns: string[] }> {
  const rows = table().prepare("SELECT * FROM domain_references WHERE projectId=? ORDER BY createdAt DESC").all(projectId) as Row[];
  const used = usageByHash(projectId);
  return rows.map((r) => ({ ...toVersion(r), usedByRuns: used.get(r.hash) ?? [] }));
}

export function readDomainReference(projectId: string, hash: string): { hash: string; title: string; text: string } {
  const row = table().prepare("SELECT * FROM domain_references WHERE projectId=? AND hash=?").get(projectId, hash) as Row | undefined;
  if (!row) throw new LedgerError(404, "domain_reference_not_found");
  return { hash: row.hash, title: row.title, text: row.text };
}

/** 存一版。空的、长得离谱的都拒收——领域参考是给规划器读一遍的，不是倾倒材料。 */
export function saveDomainReference(projectId: string, raw: unknown): DomainReferenceVersion & { created: boolean } {
  const input = (raw ?? {}) as { title?: unknown; text?: unknown };
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new LedgerError(400, "domain_reference_empty");
  if (text.length > MAX_CHARS) throw new LedgerError(400, `domain_reference_too_long:${text.length}`);
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : text.split("\n")[0]!.replace(/^#+\s*/, "")).slice(0, 120);
  const hash = hashOf(text);
  const existing = table().prepare("SELECT * FROM domain_references WHERE projectId=? AND hash=?").get(projectId, hash) as Row | undefined;
  if (existing) return { ...toVersion(existing), created: false };
  // id 带上项目：同一份参考装进两个项目是两行。
  const row: Row = { id: `dr-${projectId}-${hash.slice(0, 12)}`, projectId, hash, title, text, createdAt: new Date().toISOString() };
  table().prepare("INSERT INTO domain_references (id,projectId,hash,title,text,createdAt) VALUES (@id,@projectId,@hash,@title,@text,@createdAt)").run(row);
  return { ...toVersion(row), created: true };
}

/** 用过的版本不能删：运行的账本指着它，删了那次运行就说不清自己按什么跑的。 */
export function deleteDomainReference(projectId: string, hash: string): { deleted: true } {
  readDomainReference(projectId, hash);
  if ((usageByHash(projectId).get(hash) ?? []).length) throw new LedgerError(409, "domain_reference_in_use");
  table().prepare("DELETE FROM domain_references WHERE projectId=? AND hash=?").run(projectId, hash);
  return { deleted: true };
}

/** 项目当前那一版：最新存的。没有就是没有。 */
export function currentDomainReference(projectId: string): { hash: string; title: string; text: string } | undefined {
  const row = table().prepare("SELECT * FROM domain_references WHERE projectId=? ORDER BY createdAt DESC LIMIT 1").get(projectId) as Row | undefined;
  return row ? { hash: row.hash, title: row.title, text: row.text } : undefined;
}

/**
 * 把项目当前的领域参考冻结绑定进这次运行。没有就什么都不写。
 * `roles` 决定哪几个节点开工时拿得到它（`workflowControls.beginStage` 按角色发知识）。
 */
export function bindDomainReference(runId: string, projectId: string): { hash: string } | undefined {
  const current = currentDomainReference(projectId);
  if (!current) return undefined;
  const l = runLedger();
  if (l.listRevisions(projectId, runId).some((r) => r.name === REVISION_NAME)) return { hash: current.hash };
  l.putRevision({ projectId, runId, name: REVISION_NAME, kind: "report",
    content: { name: "domain-reference", roles: ["stories", "cases", "gate"], trust: "user-provided", executable: false,
      title: current.title, text: current.text, domainReferenceHash: current.hash } }, { kind: "system", id: "web" });
  return { hash: current.hash };
}

/** 这次运行绑定的领域参考正文；没绑定返回空串。 */
export function boundDomainReference(runId: string, projectId: string): string {
  const l = runLedger();
  const rev = l.listRevisions(projectId, runId).filter((r) => r.name === REVISION_NAME).sort((a, b) => a.revision - b.revision).at(-1);
  if (!rev) return "";
  const text = (l.readRevision(rev.id, projectId).content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}
