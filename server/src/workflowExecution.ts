import {caseEntryUrl} from './caseEntry.js';
import { recordModelRequests } from './roleSpend.js';
import { caseRunBudget, configuredRunBudget } from "./runBudget.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSON } from "@testpilot/harness-core/run-contracts";
import { resolveMap, resolveText } from "@testpilot/harness-core";
import { runLedger } from "./runService.js";
import { approvedExecutionBundle } from "./approvedRuns.js";
import { getProject, resolveEnvironment, getSecretValues, ARTIFACT_DIR } from "./db.js";
import { encryptSecret, decryptSecret } from "./vault.js";
import { execOnRunner, cancelExecution } from "./exec.js";
import { recordWorkflowCaseRun } from "./workflowRunRecord.js";
import { locatorHints } from "@testpilot/harness-testing/exec";
import { runEnvReset, guardRun } from "./executionPolicy.js";
import { LedgerError, contentHash } from "./runLedger.js";
import { captureExecutionMemory } from './runMemory.js';

interface ExecutionRow { id: string; runId: string; projectId: string; codeRevision: string; status: string; requestHash: string; environmentHash: string; environmentEnc: string; resultRevision: string | null; startedAt: string }
const active = new Map<string, string>();
const controllers = new Map<string, AbortController>();
const system = { kind: "system" as const, id: "workflow-executor" };
function ledger() {
  const ledger = runLedger();
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS workflow_executions (
    id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES wf_run_registrations(runId), projectId TEXT NOT NULL,
    idempotencyKey TEXT NOT NULL, codeRevision TEXT NOT NULL REFERENCES artifact_revisions(id), status TEXT NOT NULL,
    requestHash TEXT NOT NULL, environmentHash TEXT NOT NULL, environmentEnc TEXT NOT NULL, resultRevision TEXT,
    startedAt TEXT NOT NULL, UNIQUE(runId,idempotencyKey));`);
  return ledger;
}
export function listWorkflowExecutions(runId: string, projectId: string) {
  ledger().requireRun(runId, projectId);
  return ledger().db.prepare("SELECT id,runId,projectId,codeRevision,status,environmentHash,resultRevision,startedAt FROM workflow_executions WHERE runId=? ORDER BY startedAt DESC").all(runId);
}
function phase(row: ExecutionRow, status: string, revisionId?: string, message?:string) {
  ledger().db.prepare("UPDATE workflow_executions SET status=?,resultRevision=COALESCE(?,resultRevision) WHERE id=?").run(status, revisionId ?? null, row.id);
  ledger().db.prepare("UPDATE wf_runs SET status=? WHERE id=?").run(status === "running" ? "executing" : status === "passed" ? "completed" : status, row.runId);
  const sequence = (ledger().db.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workflow_events WHERE runId=? AND node='execution' AND attempt=0").get(row.runId) as { n: number }).n;
  ledger().appendEvent({ id: `execution-${randomUUID()}`, runId: row.runId, node: "execution", attempt: 0, sequence, at: new Date().toISOString(),
    ...(message?{message}:{}), phase: status === "passed" ? "done" : status === "running" ? "running" : status === "cancelled" ? "cancelled" : "failed", ...(revisionId ? { revisionId } : {}) }, row.projectId);
}
export function startWorkflowExecution(runId: string, projectId: string, raw: unknown) {
  /**
   * **可以只跑一部分。**
   *
   * 2026-09-13：81 条串行是 3.4 小时，而第一次上真环境要回答的问题是「这批代码跑不跑得动」，
   * 不是「跑满」。整批跑的代价还不只是时间——一次共享端点限流、一处页面就绪判错，
   * 都要等三小时才看得到；而按模块切一刀，二十分钟就能量出同样的东西。
   *
   * 所以加 `caseIds`：它进 `requestHash`（同一把幂等键换了选择集就是冲突，不是复用），
   * 也原样写进产物的 `selection`——**这次跑的是哪十条、从多少条里挑的，是查得出来的**。
   * 不给就跟以前一样整批跑，一个字节的行为都不变。
   */
  const input = z.object({ codeRevision: z.string(), idempotencyKey: z.string().min(1).max(160), envRef: z.string().optional(),
    caseIds: z.array(z.string().min(1)).min(1).optional() }).parse(raw);
  const requestHash = contentHash(canonicalJSON(input));
  const prior = ledger().db.prepare("SELECT * FROM workflow_executions WHERE runId=? AND idempotencyKey=?").get(runId, input.idempotencyKey) as ExecutionRow | undefined;
  if (prior) { if (prior.requestHash !== requestHash || prior.projectId !== projectId) throw new LedgerError(409, "execution_request_conflict"); return { executionId: prior.id, created: false, status: prior.status }; }
  const bundle = approvedExecutionBundle(runId, projectId, input.codeRevision);
  // 挑了不存在的用例要当场说，别静悄悄少跑几条。
  if (input.caseIds) {
    const have = new Set(bundle.cases.map((c) => c.id));
    const missing = input.caseIds.filter((id) => !have.has(id));
    if (missing.length) throw new LedgerError(404, `execution_case_not_in_bundle:${missing.slice(0, 5).join(",")}`);
  }
  if (["cancelled", "interrupted"].includes(String(ledger().outputs.getRun(runId)?.status))) throw new LedgerError(409, "run_requires_explicit_resume");
  if (ledger().db.prepare("SELECT id FROM workflow_executions WHERE runId=? AND status='running'").get(runId)) throw new LedgerError(409, "workflow_execution_active");
  const project = getProject(projectId); if (!project) throw new LedgerError(404, "project_missing");
  const env = resolveEnvironment(projectId, input.envRef);
  if (input.envRef && env?.id !== input.envRef && env?.name !== input.envRef) throw new LedgerError(404, "environment_missing");
  const context = { env: env?.vars ?? {}, secrets: getSecretValues(projectId) };
  /**
   * 基址的优先级：环境 > **这次运行声明的地址** > 项目级。
   *
   * 2026-09-13：g2 那一侧刚修过同一个毛病（§36.2），执行这一侧也有——
   * 这次运行按 `…/trade/ETH` 建，用例全照着那一屏写，而这里拿的是项目级的 `…/trade`。
   * 81 条里 38 条第一步不导航，会在另一个市场上开跑，一整批红而产品什么事都没有。
   * 环境仍然排第一：显式配了环境，就是要按环境跑。
   */
  const runParams = (ledger().outputs.getRun(runId)?.detail as { parameters?: { sourceUrl?: string; targetUrl?: string; exploreWallet?: boolean } } | undefined)?.parameters;
  const url = resolveText(env?.baseUrl || runParams?.sourceUrl || runParams?.targetUrl || project.targetUrl, context);
  const session = env?.login?.authRequired ? env.login.session : null;
  const login = env?.login?.authRequired && !session ? env.login.steps ?? [] : [];
  /**
   * 探索记下来的控件文案与选择器，交给执行侧当**定位提示**（docs/v3/23 F-15）。
   *
   * 用例里不会有选择器——它是端无关的。选择器留在这里，执行时先试、验不过就交回模型，
   * 见 `exec/run.ts` 的 `byLocator`。没有探索回执的 run（纯 spec 来源）拿到空表，行为不变。
   */
  const report = ledger().listRevisions(projectId, runId).filter((r) => r.name === "exploration/report")
    .sort((a, b) => a.revision - b.revision).at(-1);
  const reportContent = report ? ledger().readRevision(report.id, projectId).content : undefined;
  const locators = reportContent ? locatorHints(reportContent as Parameters<typeof locatorHints>[0]) : [];
  const selected = input.caseIds ? bundle.cases.filter((c) => input.caseIds!.includes(c.id)) : bundle.cases;
  const snapshot = { budget: caseRunBudget(selected.length), caseIds: input.caseIds, url, context, login, storageState: session,
    // 见下面 execOnRunner 里的注释：带钱包探索出来的用例，执行时也要带钱包。
    injectedWallet: runParams?.exploreWallet === true, headers: { ...resolveMap(env?.headers ?? {}, context), ...(session?.headers ?? {}) },
    query: resolveMap(env?.query ?? {}, context), viewport: env?.viewport, reset: env?.vars?.TP_RESET_CMD, locators, visualThresholdPct: env?.visualThresholdPct };
  guardRun(url, [...login, ...selected.flatMap(c => [...c.steps, ...c.postSteps])]);
  const row: ExecutionRow = { id: `exec-${randomUUID()}`, runId, projectId, codeRevision: input.codeRevision, requestHash, status: "running",
    // 选择集不进 environmentHash：跑哪几条不改变「在什么环境里跑」。它在 requestHash 里，也写进产物。
    environmentHash: contentHash(canonicalJSON({ ...snapshot, budget: undefined, caseIds: undefined })), environmentEnc: encryptSecret(JSON.stringify(snapshot)), resultRevision: null, startedAt: new Date().toISOString() };
  ledger().db.transaction(() => {
    ledger().db.prepare("INSERT INTO workflow_executions VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(row.id, runId, projectId, input.idempotencyKey, row.codeRevision, row.status,
      row.requestHash, row.environmentHash, row.environmentEnc, null, row.startedAt);
    phase(row, "running");
  })();
  void perform(row).catch(() => { phase(row, "infra_error"); });
  return { executionId: row.id, created: true, status: "running" };
}
/** 一条用例上，可重试的基础设施失败最多再试几次。 */
const RETRYABLE_INFRA_TRIES = 3;
async function perform(row: ExecutionRow) {
  const env = JSON.parse(decryptSecret(row.environmentEnc));
  const results: Array<Record<string, unknown>> = [];
  const controller = new AbortController(); controllers.set(row.id, controller);
  const budget = env.budget ?? configuredRunBudget(); const deadlineAt = Date.parse(row.startedAt) + budget.wallMs;
  let calls = 0, usageComplete = true;
  const timer = setTimeout(() => controller.abort(new Error("BUDGET_EXHAUSTED")), Math.max(1, deadlineAt - Date.now())); timer.unref();
  let status = "passed";
  const cancelled = () => (ledger().db.prepare("SELECT status FROM workflow_executions WHERE id=?").get(row.id) as { status: string }).status === "cancelled";
  try {
    const bundle = approvedExecutionBundle(row.runId, row.projectId, row.codeRevision);
    const chosen = env.caseIds ? bundle.cases.filter((c: { id: string }) => env.caseIds.includes(c.id)) : bundle.cases;
    for (const kase of chosen) {
      if (cancelled()) { status = "cancelled"; break; }
      if (controller.signal.aborted || calls >= budget.executorCalls) throw new LedgerError(409, "BUDGET_EXHAUSTED");
      approvedExecutionBundle(row.runId, row.projectId, row.codeRevision);
      runEnvReset(env.reset);
      const execId = `${row.id}-${contentHash(kase.id).slice(0, 12)}`; active.set(row.id, execId);
      const attempt = () => execOnRunner({ execId, scopeProjectId: row.projectId, modelSnapshotRunId: row.runId, url: caseEntryUrl(kase.precondition,env.url),
        steps: kase.steps, expected: kase.expected, artifactDir: ARTIFACT_DIR,
        opts: { modelBudget: { maxCalls: budget.executorCalls - calls, deadlineAt }, oracle: kase.oracle, assertions: kase.assertions, postSteps: kase.postSteps, login: env.login, storageState: env.storageState,
          resolve: env.context, extraHeaders: env.headers, query: env.query, viewport: env.viewport, locators: env.locators,
          /**
           * **带钱包探索出来的用例，执行时也要带钱包。**
           *
           * 2026-09-13：`web3Mode` 是**看板用例**上的字段，而工作流执行读的是 g2 产物——
           * 这条路上根本没有钱包。于是 81 条里绝大多数（下单、平仓、余额、挂单）会撞在
           * 未登录页面上：`Available to Trade` 是 N/A、`Place Order` 根本不出现，
           * 一整批红，而产品什么事都没有。
           *
           * 判据就是这次运行自己的起跑参数：`exploreWallet` 为真，说明这批用例是照着
           * **已连接**那一半产品写的。注入钱包与探索用的是同一个账户（`exec/injectedWallet.ts`），
           * 签名本地完成、不弹窗。
           */
          ...(env.injectedWallet ? { injected: true } : {}),
          cacheId: `${row.codeRevision}-${kase.id}` } }, { signal: controller.signal });
      /**
       * **可重试的基础设施失败，要重试，而不是把整批扔掉。**
       *
       * 2026-09-13 实测（exec-1f7d2cdd）：第 2 条用例撞上模型端一次
       * `429 upstream_http_429`，下面那句 `if (result.infraError) break` 当场停批，
       * 剩下 79 条全部记成 `not_run`。一次限流 = 一次执行报废。
       *
       * `classifyFailure` 早就分好了这一档——`MODEL_UNAVAILABLE` / `EXEC_ENV` /
       * `EXEC_TIMEOUT` 都带着 `retryable: true`，只是从来没人读它。读它，退避重试；
       * 退避从 8 秒起翻倍（8s → 16s → 32s），限流常常几十秒就过去了。
       * `ENV_RESET_FAILED` 这类 `retryable: false` 的还是当场停——那是环境真的坏了。
       *
       * 每次尝试的模型调用都要计数：失败的那次一样花了钱。
       */
      let result = await attempt();
      const attemptRequests = [...(Array.isArray(result.modelRequests) ? result.modelRequests : [])];
      for (let tries = 1; tries <= RETRYABLE_INFRA_TRIES; tries++) {
        if (!result.infraError || (result.failure as { retryable?: boolean } | undefined)?.retryable !== true) break;
        if (cancelled() || controller.signal.aborted || Date.now() >= deadlineAt) break;
        const waitMs = 8_000 * 2 ** (tries - 1);
        phase(row, "running", undefined, `${kase.id} · ${(result.failure as { code?: string } | undefined)?.code ?? "infra"} · ${waitMs / 1000}s 后重试（第 ${tries}/${RETRYABLE_INFRA_TRIES} 次）`);
        await new Promise((r) => setTimeout(r, waitMs));
        if (cancelled() || controller.signal.aborted) break;
        result = await attempt();
        if (Array.isArray(result.modelRequests)) attemptRequests.push(...result.modelRequests);
        else attemptRequests.length = 0;
      }
      if (attemptRequests.length && Array.isArray(result.modelRequests)) result = { ...result, modelRequests: attemptRequests };
      active.delete(row.id);
      results.push({ caseId: kase.id, entryUrl: caseEntryUrl(kase.precondition,env.url), ...result });
      /**
       * 落一条运行记录，顺带立/比视觉与性能基线。
       *
       * 执行每步都截了图、也量了分段墙钟，但在此之前这些都只活在执行产物里：
       * `runs` 表没有工作流的行，于是「待审批基线」那一页永远是空的。
       * 失败不该带垮这次执行——基线是附加物，不是判决。
       */
      try { recordWorkflowCaseRun({ runId: row.runId, projectId: row.projectId, executionId: row.id, visualThresholdPct: env.visualThresholdPct, result: { caseId: kase.id, ...result } as never }); }
      catch (e) { phase(row, "running", undefined, `基线未记录（${kase.id}）：${String((e as Error).message).slice(0, 80)}`); }
      if (Array.isArray(result.modelRequests)) {
        calls += result.modelRequests.filter(r => r.forwarded).length;
        const caseRevision = (bundle as typeof bundle & { approvedRevisions: string[] }).approvedRevisions.find(id => (ledger().readRevision(id, row.projectId).content as {id:string}).id === kase.id);
        recordModelRequests(row.runId, result.modelRequests, { caseRevision, executionId: row.id });
      } else usageComplete = false;
      if (cancelled()) { status = "cancelled"; break; }
      phase(row,"running",undefined,`${results.length}/${chosen.length} · ${kase.id} · ${result.status}`);
      if (!usageComplete) throw new LedgerError(409, "executor_usage_unavailable");
      approvedExecutionBundle(row.runId, row.projectId, row.codeRevision);
      if (controller.signal.aborted || result.modelRequests?.some(r => r.error === "BUDGET_EXHAUSTED")) { status = "budget_exhausted"; break; }
      if (result.infraError) { status = "infra_error"; break; }
      if (result.status === "unobservable") status = status === "failed" ? status : "unobservable";
      else if (result.status === "failed") status = "failed";
    }
  } catch (error) { if (active.has(row.id)) usageComplete = false; status = cancelled() ? "cancelled" : controller.signal.aborted || /BUDGET_EXHAUSTED/.test(String(error)) ? "budget_exhausted" : "infra_error"; results.push({ error: error instanceof LedgerError ? error.code : /ENV_RESET_FAILED/.test(String(error)) ? "ENV_RESET_FAILED" : "execution_unavailable" }); }
  finally { clearTimeout(timer); active.delete(row.id); controllers.delete(row.id); }
  /**
   * **提前中断时，没跑到的用例要留下记录。**
   *
   * 上面每一条 `break` 都可能在第 5 条上停住一批 35 条的执行（2026-09-11 实测：一条用例
   * 的清理动作失败 → `infra_error` → 整批停）。原来剩下的 30 条在报告里**根本不出现**，
   * 于是「35 条里通过 0 条」和「跑了 5 条、其中 0 条通过、另外 30 条压根没跑」
   * 在界面上长得一模一样——而这两件事对读报告的人意义完全不同。
   */
  try {
    const all = approvedExecutionBundle(row.runId, row.projectId, row.codeRevision).cases;
    /**
     * 只补**这次选中的**那些，不补没选的。
     *
     * 「批次在第 5 条之后停了」和「这 71 条本来就不在这次的选择集里」是两件事，
     * 都记成 `not_run` 会让一次 10 条的验证看起来像一次 81 条的惨败。
     * 选了哪些写在产物的 `selection` 里，谁都查得到。
     */
    const planned = env.caseIds ? all.filter((c: { id: string }) => env.caseIds.includes(c.id)) : all;
    const ran = new Set(results.map((r) => r.caseId).filter(Boolean));
    for (const kase of planned)
      if (!ran.has(kase.id))
        results.push({ caseId: kase.id, status: "not_run", failure: { code: "NOT_RUN", attribution: "infra" },
          failureReason: `批次在第 ${ran.size} 条之后以 ${status} 停止，这一条没有执行` });
  } catch { /* 读不到 bundle 就不补——宁可少一条记录，也不要在收尾里再抛一次 */ }
  const artifact = ledger().putRevision({ runId: row.runId, projectId: row.projectId, name: `execution/${row.id}`, kind: "execution",
    content: { executionId: row.id, codeRevision: row.codeRevision, environmentHash: row.environmentHash, budget, forwardedExecutorCalls: usageComplete ? calls : null, usageComplete, status,
      ...(env.caseIds ? { selection: { caseIds: env.caseIds, ran: env.caseIds.length, of: approvedExecutionBundle(row.runId, row.projectId, row.codeRevision).cases.length } } : {}),
      results, startedAt: row.startedAt, finishedAt: new Date().toISOString() },
    sourceRefs: [row.codeRevision] }, system);
  phase(row, status, artifact.id);
  captureExecutionMemory(ledger(), artifact.id, row.projectId, env.url);
}
export async function cancelWorkflowExecutions(runId: string, projectId: string) {
  ledger().requireRun(runId, projectId);
  const rows = ledger().db.prepare("SELECT * FROM workflow_executions WHERE runId=? AND status='running'").all(runId) as ExecutionRow[];
  for (const row of rows) { phase(row, "cancelled"); controllers.get(row.id)?.abort(new Error("EXEC_CANCELLED")); const execId = active.get(row.id); if (execId) await cancelExecution(execId); }
  return { cancelled: rows.length };
}
export function recoverWorkflowExecutions() {
  const rows = ledger().db.prepare("SELECT * FROM workflow_executions WHERE status='running'").all() as ExecutionRow[];
  for (const row of rows) phase(row, "interrupted");
}
