/**
 * 自进化的第一条回路：执行模型在标准集上比（docs/v3/15 阶段 9，2026-09-28 用户解冻）。
 *
 * 2026-09-27～28 正式执行三次换执行模型（mimo → qwen → deepseek），每次都是额度用完才换，换谁全凭哪家还有免费额度——
 * 没有一次量过「换了之后是更好还是更差」。这里把它变成一次可复算的比较：
 * - 候选 = 一组执行模型（当前项目的执行模型总是作为基线参加）；
 * - 每个候选在**冻结的**标准集上跑一遍（按运行与执行包版本分组，逐组正式执行，只在这一次执行里换模型，运行绑定不动）；
 * - 打分确定（standardSets.scoreExecutions），不调模型；预算固定：候选最多 4 个、用例最多 maxItems 条；
 * - 胜出只是建议：换项目的执行模型要人点头（human_review_required），换了也只影响之后开始的运行。
 *
 * 候选的凭据不进请求体：写项目密钥的名字（apiKeySecret），服务端从项目密钥里取。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSON, PrincipalSchema, type Principal } from "@testpilot/harness-core/run-contracts";
import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";
import { runLedger } from "./runService.js";
import { LedgerError } from "./runLedger.js";
import { getSecretValues } from "./db.js";
import { projectModelConnection, projectModelProfiles, saveProjectModelProfile } from "./modelProfiles.js";
import { readStandardSet, scoreExecutions, type SetScore } from "./standardSets.js";
import { startWorkflowExecution } from "./workflowExecution.js";

const CandidateInput = z.object({
  label: z.string().trim().min(1).max(60),
  endpoint: z.string().url(),
  model: z.string().trim().min(1).max(200),
  /** 项目密钥的名字；本机不要密钥的端点留空。 */
  apiKeySecret: z.string().trim().max(120).optional(),
  vlMode: z.enum(["qwen-vl", "qwen3-vl", "doubao-vision", "gemini", "vlm-ui-tars", "vlm-ui-tars-doubao", "vlm-ui-tars-doubao-1.5"]).optional(),
}).strict();
type CandidateSpec = z.infer<typeof CandidateInput>;

export interface EvaluationEntry { label: string; model: string; endpoint: string; baseline: boolean; spec?: CandidateSpec; status: "pending" | "running" | "done" | "failed"; executionIds: string[]; score?: SetScore; error?: string }
export interface Evaluation {
  id: string; projectId: string; setId: string; itemsHash: string; status: "running" | "awaiting_review" | "failed" | "promoted" | "closed";
  maxItems: number; entries: EvaluationEntry[]; createdAt: string; createdBy: string; recommendation?: string;
  decision?: { by: string; at: string; label?: string; note: string };
}

function ledger() {
  const l = runLedger();
  l.db.exec("CREATE TABLE IF NOT EXISTS standard_evaluations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, createdAt TEXT NOT NULL)");
  return l;
}
const save = (e: Evaluation) => { ledger().db.prepare("INSERT INTO standard_evaluations VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, json=excluded.json").run(e.id, e.projectId, e.status, canonicalJSON(e), e.createdAt); return e; };
export function listEvaluations(projectId: string): Evaluation[] {
  return (ledger().db.prepare("SELECT json FROM standard_evaluations WHERE projectId=? ORDER BY createdAt DESC").all(projectId) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Evaluation);
}
function read(projectId: string, id: string): Evaluation {
  const row = ledger().db.prepare("SELECT json FROM standard_evaluations WHERE id=? AND projectId=?").get(id, projectId) as { json: string } | undefined;
  if (!row) throw new LedgerError(404, "evaluation_not_found");
  return JSON.parse(row.json) as Evaluation;
}

function connectionFor(projectId: string, c: CandidateSpec): RoleModelConnection {
  const secrets = getSecretValues(projectId);
  if (c.apiKeySecret && !(c.apiKeySecret in secrets)) throw new LedgerError(400, "evaluation_secret_missing", `Project secret ${c.apiKeySecret} is not set. Add it under the project's secrets, or leave apiKeySecret empty for an endpoint without a key.`);
  return { role: "executor", endpoint: c.endpoint, model: c.model, thinking: false, timeoutMs: 900_000, ...(c.vlMode ? { vlMode: c.vlMode } : {}), apiKey: c.apiKeySecret ? secrets[c.apiKeySecret]! : "" };
}

const waitFor = async (id: string, poll: number) => {
  for (;;) {
    const row = ledger().db.prepare("SELECT status FROM workflow_executions WHERE id=?").get(id) as { status: string } | undefined;
    if (!row || row.status !== "running") return row?.status ?? "missing";
    await new Promise((r) => setTimeout(r, poll));
  }
};

/** 发起一次评估（人发起：它会在被测环境里真跑用例、花执行模型的额度）。立即返回，后台逐个候选跑。 */
export function startEvaluation(projectId: string, raw: unknown, actor: Principal, opts: { pollMs?: number } = {}) {
  const principal = PrincipalSchema.parse(actor);
  if (principal.kind !== "human") throw new LedgerError(403, "human_review_required");
  const input = z.object({ setId: z.string().min(1), candidates: z.array(CandidateInput).min(1).max(3), maxItems: z.number().int().min(1).max(60).default(20) }).parse(raw);
  const set = readStandardSet(projectId, input.setId);
  if (set.status !== "frozen") throw new LedgerError(409, "standard_set_not_frozen", "Freeze the standard set first; only a frozen set can compare candidates.");
  if (listEvaluations(projectId).some((e) => e.status === "running")) throw new LedgerError(409, "evaluation_already_running");
  const current = projectModelProfiles(projectId).executor;
  const specs: Array<{ label: string; connection: RoleModelConnection; baseline: boolean; spec?: CandidateSpec }> = [
    ...(current ? [{ label: "current", connection: projectModelConnection(projectId, "executor"), baseline: true }] : []),
    ...input.candidates.map((c) => ({ label: c.label, connection: connectionFor(projectId, c), baseline: false, spec: c })),
  ];
  const evaluation: Evaluation = { id: `eval-${randomUUID()}`, projectId, setId: set.id, itemsHash: set.itemsHash, status: "running", maxItems: input.maxItems,
    // spec 里只有密钥的名字，没有密钥本身；换模型时按它再取一次。
    entries: specs.map((s) => ({ label: s.label, model: s.connection.model, endpoint: s.connection.endpoint, baseline: s.baseline, ...(s.spec ? { spec: s.spec } : {}), status: "pending", executionIds: [] })),
    createdAt: new Date().toISOString(), createdBy: principal.id };
  save(evaluation);
  // 同一批用例、同样的顺序给每个候选：只截前 maxItems 条（集里的顺序是冻结的）。
  const items = set.items.slice(0, input.maxItems);
  const groups = new Map<string, { runId: string; codeRevision: string; caseIds: string[] }>();
  for (const i of items) { const k = `${i.runId}|${i.codeRevision}`; (groups.get(k) ?? groups.set(k, { runId: i.runId, codeRevision: i.codeRevision, caseIds: [] }).get(k)!).caseIds.push(i.caseId); }
  void (async () => {
    for (const [n, spec] of specs.entries()) {
      const entry = evaluation.entries[n]!; entry.status = "running"; save(evaluation);
      try {
        for (const [g, group] of [...groups.values()].entries()) {
          // 运行被标成 failed / infra_error 不挡执行；取消、中断的运行由 startWorkflowExecution 自己拒。
          const started = startWorkflowExecution(group.runId, projectId, { codeRevision: group.codeRevision, idempotencyKey: `${evaluation.id}-${n}-${g}`, caseIds: group.caseIds },
            { executorOverride: spec.connection, evaluation: { evaluationId: evaluation.id, setId: set.id, candidate: spec.label } });
          entry.executionIds.push(started.executionId); save(evaluation);
          await waitFor(started.executionId, opts.pollMs ?? 5000);
        }
        entry.score = scoreExecutions(projectId, set.id, entry.executionIds); entry.status = "done";
      } catch (e) { entry.status = "failed"; entry.error = (e as Error).message.slice(0, 300); }
      save(evaluation);
    }
    const scored = evaluation.entries.filter((e) => e.score);
    // 建议：通过率高者胜，平手看基础设施失败少的；候选必须严格好过基线才算建议换。
    const best = [...scored].sort((a, b) => b.score!.passRate - a.score!.passRate || a.score!.infra - b.score!.infra)[0];
    const base = scored.find((e) => e.baseline);
    evaluation.recommendation = best && !best.baseline && (!base || best.score!.passRate > base.score!.passRate) ? best.label : undefined;
    evaluation.status = scored.length ? "awaiting_review" : "failed";
    save(evaluation);
  })();
  return evaluation;
}

/** 人决定：换成某个候选（写进项目的执行模型，之后开始的运行用它），或者都不换。 */
export function decideEvaluation(projectId: string, evaluationId: string, raw: unknown, actor: Principal) {
  const principal = PrincipalSchema.parse(actor);
  if (principal.kind !== "human") throw new LedgerError(403, "human_review_required");
  const input = z.object({ decision: z.enum(["promote", "keep"]), label: z.string().optional(), note: z.string().max(2000).optional() }).parse(raw);
  const evaluation = read(projectId, evaluationId);
  if (evaluation.status !== "awaiting_review") throw new LedgerError(409, "evaluation_not_awaiting_review");
  const at = new Date().toISOString();
  if (input.decision === "promote") {
    const entry = evaluation.entries.find((e) => e.label === input.label && !e.baseline && e.status === "done");
    if (!entry?.spec) throw new LedgerError(400, "evaluation_candidate_mismatch", "Promote one of the evaluated, finished candidates by its label; the current model cannot be promoted.");
    const connection = connectionFor(projectId, entry.spec);
    const current = projectModelProfiles(projectId).executor;
    saveProjectModelProfile(projectId, "executor", { expectedVersion: current?.origin === "project" ? current.version : 0, provider: "openai-compatible", model: connection.model, endpoint: connection.endpoint,
      thinking: false, timeoutMs: connection.timeoutMs, ...(connection.vlMode ? { vlMode: connection.vlMode } : {}), capabilities: { vision: "supported", toolUse: "unknown" },
      ...(connection.apiKey ? { apiKey: connection.apiKey } : { clearCredential: true }) });
    evaluation.status = "promoted"; evaluation.decision = { by: principal.id, at, label: entry.label, note: input.note ?? "" };
  } else {
    evaluation.status = "closed"; evaluation.decision = { by: principal.id, at, note: input.note ?? "" };
  }
  return save(evaluation);
}
