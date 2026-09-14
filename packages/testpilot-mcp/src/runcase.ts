/**
 * 面向**执行**的两个工具（07 T-14）：`run_case` / `run_p0`。让 coding agent 改完前端能叫一声「跑一下 P0」。
 *
 * 走网关（`POST /api/cases/:id/run`、`POST /api/projects/:id/suite`）：判决由执行器的 oracle 层下，
 * 缓存、会话池、复位、账都在那一层，这里只翻译。**不问模型下判决**——返回的 `oracle[]` 每条带 `decidedBy`。
 *
 * 返回值治理（`docs/archive/refactor/11-工具返回值治理.md`）：截图不回传，回传报告路径；日志截到 2KB；
 * `unobservable` 单独一档（不是失败）；账（`spend`）原样带回。
 */
export interface GatewayFetch {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface RunCaseOptions {
  projectId: string;
  caseId?: string;
  title?: string;
  apiBase?: string;
  retries?: number;
  fetchImpl?: GatewayFetch;
}

export interface CaseVerdict {
  caseId: string;
  title: string;
  status: "passed" | "failed" | "unobservable";
  durationMs: number;
  oracle: Array<{ assertion: string; status: string; detail?: string; decidedBy?: string }>;
  failure?: { code?: string; kind?: string; reason?: string };
  spend?: Record<string, unknown>;
  reportPath?: string;
  /** 步骤日志，截到 2KB——完整的在报告里。 */
  logs: string;
}

const LOG_CAP = 2048;
const DEFAULT_API = process.env.TP_SERVER_URL || "http://127.0.0.1:5301";

function clipLogs(logs: unknown): string {
  const text = Array.isArray(logs) ? logs.map(String).join("\n") : String(logs ?? "");
  return text.length > LOG_CAP ? `${text.slice(0, LOG_CAP)}\n…（截到 2KB，完整日志在 reportPath）` : text;
}

function verdictOf(run: Record<string, unknown>, fallbackTitle = ""): CaseVerdict {
  const status = String(run.status ?? "failed") as CaseVerdict["status"];
  return {
    caseId: String(run.caseId ?? ""),
    title: String(run.caseTitle ?? fallbackTitle),
    status: status === "passed" || status === "unobservable" ? status : "failed",
    durationMs: Number(run.durationMs ?? 0),
    oracle: Array.isArray(run.oracle) ? (run.oracle as CaseVerdict["oracle"]) : [],
    ...(status !== "passed" ? { failure: { code: run.failCode as string | undefined, kind: run.failKind as string | undefined, reason: typeof run.failureReason === "string" ? run.failureReason.slice(0, 400) : undefined } } : {}),
    ...(run.spend ? { spend: run.spend as Record<string, unknown> } : {}),
    ...(run.reportPath ? { reportPath: String(run.reportPath) } : {}),
    logs: clipLogs(run.logs),
  };
}

/**
 * 长请求走 `node:http`，不走全局 `fetch`：undici 的 headersTimeout 默认 300 秒，一个 P0 套件要五到十分钟才回头，
 * 到点就是一句光秃秃的 `fetch failed`（2026-09-07 在 Claude Code 里撞到）。测试注入的 fetchImpl 仍走原路。
 */
async function post(fetchImpl: GatewayFetch | undefined, url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  if (fetchImpl) {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`gateway ${url} → HTTP ${res.status}${json.error ? `：${String(json.error)}` : ""}`);
    return json;
  }
  const { request } = await import("node:http");
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: timeoutMs }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        if ((res.statusCode ?? 500) >= 400) return fail(new Error(`gateway ${url} → HTTP ${res.statusCode}${json.error ? `：${String(json.error)}` : ""}`));
        ok(json);
      });
    });
    req.on("timeout", () => { req.destroy(new Error(`gateway ${url} 超过 ${Math.round(timeoutMs / 60000)} 分钟没回头`)); });
    req.on("error", fail);
    req.end(data);
  });
}

async function get(fetchImpl: GatewayFetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`gateway ${url} → HTTP ${res.status}${json.error ? `：${String(json.error)}` : ""}`);
  return json;
}

/** 按 id 或标题找用例；标题只在唯一匹配时接受。 */
export async function findCaseId(opts: { projectId: string; caseId?: string; title?: string; apiBase?: string; fetchImpl?: GatewayFetch }): Promise<{ id: string; title: string }> {
  const api = opts.apiBase ?? DEFAULT_API;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as GatewayFetch);
  const j = (await get(fetchImpl, `${api}/api/cases?projectId=${encodeURIComponent(opts.projectId)}`)) as { cases?: Array<{ id: string; title: string; priority?: string }> } | Array<{ id: string; title: string }>;
  const cases = Array.isArray(j) ? j : (j.cases ?? []);
  if (opts.caseId) {
    const c = cases.find((x) => x.id === opts.caseId);
    if (!c) throw new Error(`项目 ${opts.projectId} 里没有用例 ${opts.caseId}`);
    return { id: c.id, title: c.title };
  }
  if (!opts.title) throw new Error("run_case 需要 caseId 或 title");
  const hits = cases.filter((x) => x.title === opts.title || x.title.includes(opts.title!));
  if (hits.length !== 1) throw new Error(hits.length ? `标题「${opts.title}」匹配到 ${hits.length} 条，给 caseId` : `项目 ${opts.projectId} 里没有标题含「${opts.title}」的用例`);
  return { id: hits[0].id, title: hits[0].title };
}

export async function runCase(opts: RunCaseOptions): Promise<CaseVerdict> {
  const api = opts.apiBase ?? DEFAULT_API;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as GatewayFetch);
  const target = await findCaseId({ ...opts, apiBase: api, fetchImpl });
  const j = (await post(opts.fetchImpl, `${api}/api/cases/${encodeURIComponent(target.id)}/run`, { retries: opts.retries ?? 0, modelSnapshotRunId: process.env.TP_MODEL_RUN_ID || undefined }, 15 * 60_000)) as { run?: Record<string, unknown> };
  if (!j.run) throw new Error("网关没有返回运行记录");
  // 账在 `updateRunResults` 之后才进库，HTTP 响应里的 run 对象没带它——按 id 再读一次。
  const full = (await get(fetchImpl, `${api}/api/runs/${encodeURIComponent(String(j.run.id))}`).catch(() => null)) as { run?: Record<string, unknown> } | null;
  return verdictOf({ ...j.run, ...(full?.run ?? {}) }, target.title);
}

export interface P0Result {
  projectId: string;
  batchId: string;
  gate: "pass" | "fail";
  total: number;
  passed: number;
  failed: number;
  unobservable: number;
  infra: number;
  cases: CaseVerdict[];
  spend: { modelCalls: number; tokens: number; modelMs: number; wallMs: number };
}

export async function runP0(opts: { projectId: string; apiBase?: string; retries?: number; filter?: "P0" | "P1" | "P2" | "all"; fetchImpl?: GatewayFetch }): Promise<P0Result> {
  const api = opts.apiBase ?? DEFAULT_API;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as GatewayFetch);
  const j = (await post(opts.fetchImpl, `${api}/api/projects/${encodeURIComponent(opts.projectId)}/suite`, { filter: opts.filter ?? "P0", retries: opts.retries ?? 0, modelSnapshotRunId: process.env.TP_MODEL_RUN_ID || undefined }, 60 * 60_000)) as {
    batch: { id: string; total: number; passed: number; failed: number; gate?: string };
    items: Array<{ runId?: string | null; caseId: string; caseTitle: string; status: string }>;
    gate: "pass" | "fail";
  };
  const cases: CaseVerdict[] = [];
  const spend = { modelCalls: 0, tokens: 0, modelMs: 0, wallMs: 0 };
  for (const it of j.items ?? []) {
    if (!it.runId) {
      cases.push({ caseId: it.caseId, title: it.caseTitle, status: "failed", durationMs: 0, oracle: [], failure: { kind: "infra", reason: "没有运行记录：用例没跑起来（runner 忙或起跑异常）" }, logs: "" });
      continue;
    }
    const full = (await get(fetchImpl, `${api}/api/runs/${encodeURIComponent(it.runId)}`).catch(() => null)) as { run?: Record<string, unknown> } | null;
    const v = verdictOf(full?.run ?? { caseId: it.caseId, caseTitle: it.caseTitle, status: it.status }, it.caseTitle);
    cases.push(v);
    const sp = (v.spend ?? {}) as Record<string, number>;
    spend.modelCalls += sp.modelCalls ?? 0;
    spend.tokens += sp.tokens ?? 0;
    spend.modelMs += sp.modelMs ?? 0;
    spend.wallMs += v.durationMs;
  }
  return {
    projectId: opts.projectId,
    batchId: j.batch.id,
    gate: j.gate,
    total: j.batch.total,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    unobservable: cases.filter((c) => c.status === "unobservable").length,
    infra: cases.filter((c) => c.failure?.kind === "infra").length,
    cases,
    spend,
  };
}
