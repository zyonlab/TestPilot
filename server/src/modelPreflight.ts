import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";

/**
 * 开跑前探一次执行模型（docs/v3/15 阶段 5.1）。
 *
 * 2026-09-27～28 正式执行三次撞在执行模型额度上（runinfra 402、tokenharbor 两个免费档 429），
 * 每次都是跑了几条、甚至收尾补偿时才撞上——POS-05-03 就因为补偿那一刻 429，真留下了一笔持仓。
 * 开跑前花一次最小的调用，额度用完、key 失效就不开跑，并把服务商的原话带回来。
 *
 * 只在端点**明确说不**（401/402/403/429）时拦；连不上、超时这类判断不了的，照常开跑——
 * 预检是为了早点知道坏消息，不是为了多一个会误拦的关卡。
 */
export type PreflightVerdict = { ok: true } | { ok: false; status: number; message: string };

const REFUSALS = new Set([401, 402, 403, 429]);

export async function executorPreflight(c: Pick<RoleModelConnection, "endpoint" | "model" | "apiKey">, fetchImpl: typeof fetch = fetch): Promise<PreflightVerdict> {
  let res: Response;
  try {
    res = await fetchImpl(`${c.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ model: c.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch { return { ok: true }; }
  if (!REFUSALS.has(res.status)) return { ok: true };
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json() as { error?: { message?: unknown } | string; message?: unknown };
    const said = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
    if (typeof said === "string" && said.trim()) message = said.trim();
  } catch { /* 没有正文就只报状态码 */ }
  if (c.apiKey) message = message.split(c.apiKey).join("[redacted]");
  return { ok: false, status: res.status, message: message.slice(0, 300) };
}
