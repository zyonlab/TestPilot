import { usageReader, type ProviderTokenUsage } from "./usage.js";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { requireModelConnection, type RoleModelConnection } from "./profiles.js";
import { flavorOf } from "./flavor.js";

/** Keep provider diagnostics useful without persisting their echoed prompts or credentials. */
/** 上游说「这一刻不行」时，在代理里最多再试几次。见下面 forward 里的注释。 */
const UPSTREAM_RETRIES = Number(process.env.TP_UPSTREAM_RETRIES ?? 4);
async function providerError(response: Response): Promise<string> {
  const reader = response.body?.getReader(); let text = '';
  if (reader) try {
    let bytes = 0;
    while (bytes < 16_384) {
      const part = await reader.read(); if (part.done) break;
      text += new TextDecoder().decode(part.value.subarray(0, 16_384 - bytes)); bytes += part.value.length;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const classifications: [RegExp, string][] = [
    [/context.{0,35}(length|limit|exceed)|too many tokens|maximum.{0,20}tokens|prompt.{0,20}too long/i, 'context_limit'],
    [/image.{0,35}(invalid|unsupported|limit|large)|vision.{0,30}(support|invalid)|does not support.{0,20}image/i, 'image_unsupported'],
    [/max_tokens|maximum output|completion_tokens/i, 'output_token_limit'],
    [/quota|insufficient.{0,10}(credit|balance)|billing/i, 'quota'],
    [/response_format|json_schema|json_object/i, 'response_format'],
    [/unsupported.{0,20}param|unknown.{0,20}param|unrecognized.{0,20}param/i, 'unsupported_parameter'],
  ];
  const category = classifications.find(([pattern]) => pattern.test(text))?.[1];
  return `upstream_http_${response.status}${category ? '_' + category : ''}`;
}

export interface RoleProxyBudget { maxCalls?: number; deadlineAt?: number }
export interface RoleRequestRecord {
  requestId?: string; at?: string; forwarded?: boolean; usage?: ProviderTokenUsage | null; error?: string;
  role: RoleModelConnection["role"];
  model: string;
  endpoint: string;
  thinking: boolean | null;
  status: number;
  ms: number;
}

/** Pinned local adapter for SDKs without a per-request body hook. No global env writes. */
export async function openRoleProxy(input: RoleModelConnection, onRequest?: (record: RoleRequestRecord) => void, budget: RoleProxyBudget = {}) {
  const c = requireModelConnection(input.role, input);
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const active = new Set<AbortController>();
  const records: RoleRequestRecord[] = []; let forwardedCalls = 0;
  if ((budget.maxCalls !== undefined && (!Number.isInteger(budget.maxCalls) || budget.maxCalls < 0)) || (budget.deadlineAt !== undefined && !Number.isFinite(budget.deadlineAt))) throw new Error("invalid_model_budget");
  const server = createServer(async (req, res) => {
    const key = Buffer.from(req.headers.authorization ?? "");
    const jsonError = (status: number, code: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: code, type: "testpilot_model_error" } }));
    };
    if (key.length !== expected.length || !timingSafeEqual(key, expected)) return jsonError(401, "invalid_model_session");
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return jsonError(404, "unsupported_model_route");
    const controller = new AbortController(); active.add(controller);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const started = Date.now(); let status = 502, forwarded = false, errorCode: string | undefined; let usage: ProviderTokenUsage | null = null;
    const timer = setTimeout(() => controller.abort(), Math.min(c.timeoutMs ?? 900_000, budget.deadlineAt ? Math.max(1, budget.deadlineAt - Date.now()) : Infinity)); timer.unref();
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of req) {
        const chunk = Buffer.from(part); size += chunk.length;
        if (size > 24 * 1024 * 1024) { status = 413; jsonError(status, "model_request_too_large"); return; }
        chunks.push(chunk);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
        if (!body || Array.isArray(body) || typeof body !== "object" || body.model !== c.model) throw new Error();
      } catch { status = 400; jsonError(status, "invalid_model_request"); return; }
      // An SDK default must not override the role's requested thinking policy.
      for (const field of ["enable_thinking", "thinking_budget", "reasoning_effort", "reasoning_format", "thinking"]) delete body[field];
      const template = body.chat_template_kwargs;
      if (template && typeof template === "object" && !Array.isArray(template)) {
        body.chat_template_kwargs = { ...template }; delete (body.chat_template_kwargs as Record<string, unknown>).enable_thinking;
      }
      if (c.thinking !== null) {
        if (flavorOf(c.endpoint) === "groq") {
          if (c.thinking) body.reasoning_format = "hidden";
          else body.reasoning_effort = "none";
        } else {
          body.enable_thinking = c.thinking;
          body.chat_template_kwargs = { ...(body.chat_template_kwargs as object ?? {}), enable_thinking: c.thinking };
          if (c.thinking && c.thinkBudget !== undefined) body.thinking_budget = c.thinkBudget;
          /**
           * 关思考还要发 `reasoning_effort: "none"`。
           *
           * 上面那两个是 vLLM / Qwen 系的厂商扩展，**不是所有 OpenAI 兼容端点都认**。
           * 2026-09-11 在 api.runinfra.ai 上实测：只发那两个，`reasoning_tokens` 仍然是 22–28；
           * 加上 `reasoning_effort: "none"` 才降到 0。后果不是"回答啰嗦一点"——
           * 推理会把 `max_tokens` 吃光，`finish_reason=length` 而 `content` 是空串，
           * Midscene 那头看到的是 `failed to call AI model service: empty content`，
           * 一次执行就此判成 MODEL_UNAVAILABLE。查了半天像是端点挂了，其实是这个开关没生效。
           *
           * `reasoning_effort` 是 OpenAI Chat Completions 的标准字段，不是厂商扩展，
           * 所以对兼容端点是安全的；Groq 那一支早就在用它（上面那个分支）。
           */
          if (!c.thinking) body.reasoning_effort = "none";
        }
      }
      if (forwardedCalls >= (budget.maxCalls ?? Infinity) || Date.now() >= (budget.deadlineAt ?? Infinity)) { status = 429; errorCode = "BUDGET_EXHAUSTED"; jsonError(status, errorCode); return; }
      forwardedCalls++; forwarded = true;
      const send = () => fetch(`${c.endpoint.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      /**
       * **「这一刻不行」要在这里等，不能让它穿出去。**
       *
       * 2026-09-13 实测（exec-564f3721）：共享端点回
       * `hosted_shared_model_concurrency_limit`——16 个并发位被别的租户占满了，
       * 一阵一阵的（同一分钟里探 6 次全 200，再一分钟 4 次全 429）。这个 429 原样穿到
       * Midscene，变成 `failed to call AI model service: 429 upstream_http_429`，
       * 于是**一条用例整条报废**：22 秒的驱动、一次起浏览器、后面所有断言，全不作数。
       *
       * 规划侧的 `openai.ts` 早就在做这件事（5xx 与 429 退避重试），而执行侧走的是这条
       * 代理，它没有。补在这里，一次限流只是让这个调用慢几秒；上面那层「整条用例重跑」
       * 的退避留着兜底，不是第一道防线。
       *
       * 服务端说了什么时候回来，就听它的：`Retry-After` 是秒或 HTTP 日期。
       */
      let upstream = await send();
      for (let attempt = 1; attempt <= UPSTREAM_RETRIES; attempt++) {
        if (upstream.status !== 429 && upstream.status < 500) break;
        if (controller.signal.aborted || Date.now() >= (budget.deadlineAt ?? Infinity)) break;
        const header = upstream.headers.get("retry-after");
        const advised = header ? (/^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : NaN;
        const waitMs = Math.min(30_000, Number.isFinite(advised) && advised >= 0 ? advised : attempt * 2_000);
        await upstream.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, waitMs));
        if (controller.signal.aborted) break;
        upstream = await send();
      }
      status = upstream.status;
      if (!upstream.ok) {
        errorCode = await providerError(upstream); jsonError(status, errorCode); return;
      }
      res.writeHead(status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const usageStream = usageReader((upstream.headers.get("content-type") ?? "").includes("text/event-stream"));
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            usageStream.push(value);
            if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
          }
        } finally { usage = usageStream.finish(); reader.releaseLock(); }
      }
      res.end();
    } catch {
      status = controller.signal.aborted ? 504 : 502;
      if (!res.headersSent && !res.destroyed) jsonError(status, controller.signal.aborted ? "model_request_cancelled_or_timed_out" : "model_transport_failed");
      else res.destroy();
    } finally {
      clearTimeout(timer); active.delete(controller);
      const record: RoleRequestRecord = { requestId: randomUUID(), at: new Date(started).toISOString(), role: c.role, model: c.model, endpoint: c.endpoint, thinking: c.thinking, status, ms: Date.now() - started, forwarded, usage, ...(errorCode ? { error: errorCode } : {}) };
      records.push(record);
      try { onRequest?.(record); } catch { /* Observability cannot break the request. */ }
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const connection: RoleModelConnection = { ...c, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: token };
  let closed: Promise<void> | undefined;
  return { connection, records, close: () => closed ??= new Promise<void>(resolve => {
    for (const controller of active) controller.abort();
    server.close(() => resolve()); server.closeAllConnections();
  }) };
}
