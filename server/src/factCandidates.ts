/**
 * 经验沉淀成界面事实（docs/v3/15 阶段 7，2026-09-28 用户解冻「经验与反例库」）。
 *
 * 2026-09-27～28 这类事实全靠人翻日志才进领域参考：「超额时按钮直接变成禁用的 Not Enough Margin」
 * 在正式执行的失败原因里写得清清楚楚，却要等人读到、再手写进领域参考，下一批用例才不会再写「点 Place Order 看拒绝」。
 *
 * 这里把「读日志」自动化，**生效仍然要人点头**（领域内容是项目数据，由用户决定）：
 * - 每次准备试跑 / 正式执行出结果后，从失败原因、判据与核对的说明里取加了引号的界面字面值；
 * - 领域参考、这次运行绑定的材料里已经有的不要；用例步骤自己写的不要（那是用例的说法，不是观察）；
 * - 记证据：`screen` = 这次结果记下的页面文字里真的有它；`reported` = 只在模型或核对的话里出现；
 * - 同一个字面值再出现只加证据与次数。人在运行详情页的「界面事实候选」面板确认，确认时写一句事实，存成项目知识库（`domain_knowledge`）里领域参考的新版本——
 *   新建运行时选中这一版才绑定进运行（不是「领域参考」页那张 `domain_references` 表）；驳回的不再冒出来。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSON, PrincipalSchema, type Principal } from "@testpilot/harness-core/run-contracts";
import { runLedger } from "./runService.js";
import { LedgerError } from "./runLedger.js";
import { db, getProject } from "./db.js";
import { boundDomainReference } from "./domainReferences.js";
import { saveKnowledgeLibrary } from "./knowledgeLibrary.js";

export type FactEvidence = { runId: string; caseId: string; receipt: string; kind: "screen" | "reported"; excerpt: string; at: string };
export interface FactCandidate {
  id: string; projectId: string; literal: string; status: "pending" | "accepted" | "dismissed";
  evidence: FactEvidence[]; seen: number; createdAt: string; updatedAt: string;
  decision?: { by: string; at: string; note: string; fact?: string; referenceId?: string };
}

const QUOTED = /「([^「」\n]{2,60})」|“([^“”\n]{2,60})”/g;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
// 界面上的字是标签、按钮、提示；带句读的是一句话（多半是判官条件或模型的描述），不是字面值。
const isLiteral = (t: string) => !t.includes("${") && !/^[\d\s.,:%$+\-/()]+$/.test(t) && !/[，。；：、？！（）]/.test(t);

function table() {
  const l = runLedger();
  l.db.exec(`CREATE TABLE IF NOT EXISTS fact_candidates (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, literalKey TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, updatedAt TEXT NOT NULL,
    UNIQUE(projectId, literalKey))`);
  return l;
}

/** 项目里最新的领域参考正文（知识库里人存的最新一版）。 */
function latestProjectReference(projectId: string): string {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS domain_knowledge (projectId TEXT NOT NULL,hash TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(projectId,hash))");
    return (db.prepare("SELECT text FROM domain_knowledge WHERE projectId=? ORDER BY createdAt DESC LIMIT 1").get(projectId) as { text?: string } | undefined)?.text ?? "";
  } catch { return ""; }
}

function knownCorpus(runId: string, projectId: string): string {
  const l = runLedger();
  let materials: string[] = [];
  try { materials = l.requireRun(runId, projectId).binding.materialRevisions.map((id) => { const c = l.readRevision(id, projectId).content; return typeof c === "string" ? c : canonicalJSON(c); }); }
  catch { /* 没封材料的运行：只和领域参考比 */ }
  return norm([latestProjectReference(projectId), boundDomainReference(runId, projectId), ...materials].join("\n"));
}

type ResultLike = {
  failureReason?: string; unobservableReason?: string; logs?: string[];
  oracle?: Array<{ detail?: string; assertion?: string }>;
  prerequisiteChecks?: Array<{ detail?: string }>;
  lifecycle?: { checks?: Array<{ detail?: string }>; cleanup?: Array<{ detail?: string }> };
  observations?: Array<{ text?: string }>;
};

/** 一次结果里「模型或核对说到、用例自己没写、领域数据里也没有」的界面字面值。纯函数，便于测试。 */
export function literalsFromResult(result: ResultLike, known: string, caseText = ""): Array<{ literal: string; kind: FactEvidence["kind"]; excerpt: string }> {
  const said = [result.failureReason, result.unobservableReason, ...(result.oracle ?? []).map((o) => o.detail),
    ...(result.prerequisiteChecks ?? []).map((c) => c.detail), ...(result.lifecycle?.checks ?? []).map((c) => c.detail),
    ...(result.lifecycle?.cleanup ?? []).map((c) => c.detail)].filter((t): t is string => !!t);
  // 日志里执行器复述的步骤原文也算用例自己的说法。
  const own = norm([caseText, ...(result.logs ?? []).filter((l) => /^\s*(step \d+:|login:|post)/i.test(l))].join("\n"));
  const screen = norm((result.observations ?? []).map((o) => o.text ?? "").join("\n"));
  const out = new Map<string, { literal: string; kind: FactEvidence["kind"]; excerpt: string }>();
  for (const text of said) for (const m of text.matchAll(QUOTED)) {
    const literal = (m[1] ?? m[2] ?? "").trim(), key = norm(literal);
    if (!isLiteral(literal) || out.has(key) || known.includes(key) || own.includes(key)) continue;
    const at = Math.max(0, (m.index ?? 0) - 60);
    out.set(key, { literal, kind: screen.includes(key) ? "screen" : "reported", excerpt: text.slice(at, at + 200).replace(/\s+/g, " ") });
  }
  return [...out.values()];
}

/** 把一次结果里的候选记下来。失败只记日志、不抛：它是附加物，不该带垮准备或执行。 */
export function recordFactCandidates(input: { projectId: string; runId: string; caseId: string; receipt: string; result: ResultLike; caseText?: string }): FactCandidate[] {
  try {
    const found = literalsFromResult(input.result, knownCorpus(input.runId, input.projectId), input.caseText ?? "");
    if (!found.length) return [];
    const l = table(), now = new Date().toISOString(), touched: FactCandidate[] = [];
    l.db.transaction(() => {
      for (const f of found) {
        const evidence: FactEvidence = { runId: input.runId, caseId: input.caseId, receipt: input.receipt, kind: f.kind, excerpt: f.excerpt, at: now };
        const row = l.db.prepare("SELECT json FROM fact_candidates WHERE projectId=? AND literalKey=?").get(input.projectId, norm(f.literal)) as { json: string } | undefined;
        if (row) {
          const prior = JSON.parse(row.json) as FactCandidate;
          if (prior.status !== "pending" || prior.evidence.some((e) => e.receipt === input.receipt)) continue;
          const next = { ...prior, seen: prior.seen + 1, evidence: [...prior.evidence, evidence].slice(-10), updatedAt: now };
          l.db.prepare("UPDATE fact_candidates SET json=?, updatedAt=? WHERE id=?").run(canonicalJSON(next), now, prior.id);
          touched.push(next);
        } else {
          const next: FactCandidate = { id: `fact-${randomUUID()}`, projectId: input.projectId, literal: f.literal, status: "pending", evidence: [evidence], seen: 1, createdAt: now, updatedAt: now };
          l.db.prepare("INSERT INTO fact_candidates VALUES (?,?,?,?,?,?)").run(next.id, input.projectId, norm(f.literal), "pending", canonicalJSON(next), now);
          touched.push(next);
        }
      }
    })();
    return touched;
  } catch { return []; }
}

export function listFactCandidates(projectId: string, status?: string): FactCandidate[] {
  if (!getProject(projectId)) throw new LedgerError(404, "project_missing");
  return (table().db.prepare("SELECT json FROM fact_candidates WHERE projectId=? ORDER BY updatedAt DESC").all(projectId) as Array<{ json: string }>)
    .map((r) => JSON.parse(r.json) as FactCandidate).filter((c) => !status || c.status === status)
    // 有屏幕证据、出现次数多的排前面。
    .sort((a, b) => Number(b.evidence.some((e) => e.kind === "screen")) - Number(a.evidence.some((e) => e.kind === "screen")) || b.seen - a.seen);
}

/**
 * 人确认或驳回。确认要写一句事实（这个字面值在什么情况下出现），合进领域参考的新版本：
 * 在最新一版末尾的「界面实测事实（自动沉淀，人已确认）」一节追加一条，带证据来源。
 */
export function decideFactCandidate(projectId: string, candidateId: string, raw: unknown, actor: Principal) {
  const principal = PrincipalSchema.parse(actor);
  if (principal.kind !== "human") throw new LedgerError(403, "human_review_required");
  const input = z.object({ decision: z.enum(["accepted", "dismissed"]), fact: z.string().trim().max(600).optional(), note: z.string().max(2000).optional() }).parse(raw);
  if (input.decision === "accepted" && (input.fact ?? "").length < 4) throw new LedgerError(400, "fact_statement_required", "Write one sentence saying when this label appears on the screen; it goes into the domain reference as written.");
  const l = table();
  const row = l.db.prepare("SELECT json FROM fact_candidates WHERE id=? AND projectId=?").get(candidateId, projectId) as { json: string } | undefined;
  if (!row) throw new LedgerError(404, "fact_candidate_not_found");
  const prior = JSON.parse(row.json) as FactCandidate;
  if (prior.status !== "pending") {
    if (prior.status === input.decision) return { candidate: prior, status: "unchanged" };
    throw new LedgerError(409, "fact_candidate_already_decided");
  }
  const at = new Date().toISOString();
  let referenceId: string | undefined;
  if (input.decision === "accepted") {
    const heading = "## 界面实测事实（自动沉淀，人已确认）";
    const base = latestProjectReference(projectId).trimEnd();
    const sources = [...new Set(prior.evidence.map((e) => `${e.caseId}（${e.runId.slice(0, 12)} · ${e.kind === "screen" ? "页面文字里有" : "执行器报告"}）`))].slice(0, 4).join("、");
    const bullet = `- 「${prior.literal}」：${input.fact}\n  来源：${sources}；确认：${principal.id} ${at.slice(0, 10)}。状态：有效。`;
    const text = base.includes(heading) ? `${base}\n${bullet}\n` : `${base}\n\n\n${heading}\n\n${bullet}\n`;
    referenceId = saveKnowledgeLibrary(projectId, "domainKnowledge", { title: `领域参考（${at.slice(0, 10)} 确认「${prior.literal.slice(0, 40)}」）`, value: text }, principal).id;
  }
  const next: FactCandidate = { ...prior, status: input.decision, updatedAt: at, decision: { by: principal.id, at, note: input.note ?? "", ...(input.fact ? { fact: input.fact } : {}), ...(referenceId ? { referenceId } : {}) } };
  l.db.prepare("UPDATE fact_candidates SET status=?, json=?, updatedAt=? WHERE id=?").run(input.decision, canonicalJSON(next), at, candidateId);
  return { candidate: next, status: "recorded", referenceId: referenceId ?? null };
}

/** 补挖一个已有运行（上线前积下来的准备与执行结果）。幂等：同一回执不会重复加证据。 */
export function mineRunFacts(runId: string, projectId: string) {
  const l = runLedger();
  l.requireRun(runId, projectId);
  let results = 0; const touched = new Map<string, FactCandidate>();
  for (const rev of l.listRevisions(projectId, runId)) {
    const prep = /^preparation\/[^/]+\/([^/]+)\/(?:probe|round)-\d+\/result$/.exec(rev.name);
    const items: Array<{ caseId: string; result: ResultLike }> = prep ? [{ caseId: prep[1]!, result: l.readRevision(rev.id, projectId).content as ResultLike }]
      : rev.name.startsWith("execution/") ? (((l.readRevision(rev.id, projectId).content as { results?: Array<ResultLike & { caseId?: string; status?: string }> }).results ?? [])
          .filter((r) => r.caseId && r.status !== "not_run").map((r) => ({ caseId: r.caseId!, result: r }))) : [];
    for (const item of items) {
      results++;
      // 用例自己写的字（步骤、判据、判官条件）不算观察：取这条用例最新的复核版本。
      const review = l.listRevisions(projectId, runId).filter((r) => r.name === `review/case/${item.caseId}`).sort((a, b) => a.revision - b.revision).at(-1);
      const caseText = review ? canonicalJSON(l.readRevision(review.id, projectId).content) : "";
      for (const c of recordFactCandidates({ projectId, runId, caseId: item.caseId, receipt: rev.id, result: item.result, caseText })) touched.set(c.id, c);
    }
  }
  return { results, candidates: [...touched.values()].map((c) => ({ id: c.id, literal: c.literal, seen: c.seen })) };
}
