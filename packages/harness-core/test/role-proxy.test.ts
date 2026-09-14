import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { openRoleProxy, type RoleRequestRecord } from "../src/model/role-proxy.js";
import type { RoleModelConnection } from "../src/model/profiles.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function upstream(reply?: (res: import("node:http").ServerResponse) => void) {
  const requests: { key?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
    requests.push({ key: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (reply) reply(res); else { res.setHeader("content-type", "application/json"); res.end('{"choices":[{"message":{"content":"ok"}}]}'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}
function post(c: RoleModelConnection, body: Record<string, unknown> = {}, key = c.apiKey) {
  return fetch(`${c.endpoint}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: c.model, messages: [], ...body }) });
}

it("pins endpoint/key/model and thinking independently for concurrent SDK clients", async () => {
  const a = await upstream(), b = await upstream();
  const records: RoleRequestRecord[] = [];
  const original: RoleModelConnection = { role: "planner", endpoint: a.endpoint, model: "reasoner", apiKey: "planner-secret", thinking: true, thinkBudget: 128 };
  // Only the transport contract crosses this boundary.
  const p = await openRoleProxy(original, r => records.push(r));
  const e = await openRoleProxy({ role: "executor", endpoint: b.endpoint, model: "vision", apiKey: "executor-secret", thinking: false }, r => records.push(r));
  cleanup.push(p.close, e.close); original.apiKey = "changed";
  await Promise.all([post(p.connection, { enable_thinking: false }), post(e.connection, { enable_thinking: true, reasoning_effort: "high" })]);
  expect(a.requests[0]).toMatchObject({ key: "Bearer planner-secret", body: { model: "reasoner", enable_thinking: true, thinking_budget: 128 } });
  expect(b.requests[0]).toMatchObject({ key: "Bearer executor-secret", body: { model: "vision", enable_thinking: false, chat_template_kwargs: { enable_thinking: false } } });
  /**
   * SDK 自己带的 `reasoning_effort: "high"` 必须被角色策略盖掉，而不是被原样转发。
   * 盖成 `"none"` 而不是删掉：2026-09-11 实测有的兼容端点两个厂商扩展都不认，
   * 只认这个标准字段；删掉它等于关思考没生效，推理会把 max_tokens 吃光、content 为空。
   */
  expect(b.requests[0].body).toMatchObject({ reasoning_effort: "none" });
  expect(JSON.stringify(records)).not.toMatch(/secret|Bearer/);
  expect((await post(p.connection, {}, "wrong")).status).toBe(401);
  expect((await post(p.connection, { model: "other" })).status).toBe(400);
  expect(a.requests).toHaveLength(1);
});

it("allows anonymous upstreams and removes SDK thinking defaults when the profile is null", async () => {
  const target = await upstream();
  const proxy = await openRoleProxy({ role: "executor", endpoint: target.endpoint, model: "vision", apiKey: "", thinking: null }); cleanup.push(proxy.close);
  await post(proxy.connection, { reasoning_effort: "medium", enable_thinking: true });
  expect(target.requests[0].key).toBeUndefined();
  expect(target.requests[0].body).not.toHaveProperty("enable_thinking");
  expect(target.requests[0].body).not.toHaveProperty("reasoning_effort");
});

it("preserves SSE chunks and closes its port idempotently", async () => {
  const target = await upstream(res => { res.setHeader("content-type", "text/event-stream"); res.write('data: {"part":1}\n\n'); res.end('data: [DONE]\n\n'); });
  const proxy = await openRoleProxy({ role: "planner", endpoint: target.endpoint, model: "reasoner", apiKey: "key", thinking: null });
  const res = await post(proxy.connection, { stream: true });
  expect(await res.text()).toBe('data: {"part":1}\n\ndata: [DONE]\n\n');
  await proxy.close(); await proxy.close();
  await expect(post(proxy.connection)).rejects.toThrow();
});

it("does not forward provider error bodies", async () => {
  const target = await upstream(res => { res.writeHead(401); res.end('provider echoed a-secret-key'); });
  const proxy = await openRoleProxy({ role: "executor", endpoint: target.endpoint, model: "vision", apiKey: "a-secret-key", thinking: false }); cleanup.push(proxy.close);
  const res = await post(proxy.connection);
  expect(res.status).toBe(401); expect(await res.text()).not.toContain("a-secret-key");
});

it("classifies context failures without retaining provider text or secrets", async () => {
  const target = await upstream(res => { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Maximum context length exceeded. Prompt: PRIVATE_TEXT key=PRIVATE_KEY' } })); });
  const proxy = await openRoleProxy({ role: 'executor', endpoint: target.endpoint, model: 'vision', apiKey: 'PRIVATE_KEY', thinking: false }); cleanup.push(proxy.close);
  const res = await post(proxy.connection);
  expect(await res.text()).toContain('upstream_http_400_context_limit');
  expect(proxy.records[0].error).toBe('upstream_http_400_context_limit');
  expect(JSON.stringify(proxy.records)).not.toContain('PRIVATE');
});

it("refuses redirects without sending credentials to the new endpoint", async () => {
  const other = await upstream();
  const target = await upstream(res => { res.writeHead(307, { location: `${other.endpoint}/chat/completions` }); res.end(); });
  const proxy = await openRoleProxy({ role: "executor", endpoint: target.endpoint, model: "vision", apiKey: "private", thinking: null }); cleanup.push(proxy.close);
  expect((await post(proxy.connection)).status).toBe(502);
  expect(other.requests).toHaveLength(0);
});

it("times out stalled upstreams and closes active requests", async () => {
  const target = await upstream(() => {});
  const records: RoleRequestRecord[] = [];
  const proxy = await openRoleProxy({ role: "planner", endpoint: target.endpoint, model: "reasoner", apiKey: "key", thinking: null, timeoutMs: 50 }, r => records.push(r)); cleanup.push(proxy.close);
  const response = await post(proxy.connection);
  expect(response.status).toBe(504); expect(records[0].status).toBe(504);
  const pending = post(proxy.connection).then(r => r.status, () => "closed");
  await proxy.close();
  expect([504, "closed"]).toContain(await pending);
});
it("records provider usage exactly, preserves missing fields, and blocks concurrent requests beyond the role budget", async () => {
  const target = await upstream(res => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, prompt_tokens_details: { cached_tokens: 100 } } })); });
  const proxy = await openRoleProxy({ role: "executor", endpoint: target.endpoint, model: "v", apiKey: "", thinking: null }, undefined, { maxCalls: 1 }); cleanup.push(proxy.close);
  const responses = await Promise.all([post(proxy.connection), post(proxy.connection)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 429]);
  await Promise.all(responses.map(r => r.text()));
  expect(target.requests).toHaveLength(1);
  expect(proxy.records.find(r => r.forwarded)?.usage).toEqual({ inputTokens: 120, outputTokens: 8, totalTokens: 128, cachedInputTokens: 100 });
  expect(proxy.records.find(r => !r.forwarded)).toMatchObject({ error: "BUDGET_EXHAUSTED", usage: null });
});
it("extracts split SSE usage without retaining model text and distinguishes zero tokens from unknown", async () => {
  const { usageReader, normalizeUsage } = await import('../src/model/usage.js');
  const reader = usageReader(true), text = 'data: {"choices":[{"delta":{"content":"PRIVATE_MODEL_TEXT"}}]}\n\ndata: {"usage":{"prompt_tokens":0,"completion_tokens":4}}\n\ndata: [DONE]\n';
  for (const char of text) reader.push(new TextEncoder().encode(char));
  expect(reader.finish()).toEqual({ inputTokens: 0, outputTokens: 4, totalTokens: null, cachedInputTokens: null });
  expect(normalizeUsage({})).toBeNull(); expect(normalizeUsage({ prompt_tokens: -1 })).toBeNull();
});

/**
 * 2026-09-13 exec-564f3721：共享端点回 `hosted_shared_model_concurrency_limit`，
 * 429 原样穿到 Midscene，一条跑了 22 秒的用例整条报废。代理该在这里等，而不是让它穿出去。
 */
it("上游 429 在代理里退避重试，并听 Retry-After", async () => {
  let n = 0;
  const up = await upstream((res) => {
    n += 1;
    if (n <= 2) { res.setHeader("retry-after", "0"); res.statusCode = 429; res.setHeader("content-type", "application/json"); res.end('{"error":{"code":"hosted_shared_model_concurrency_limit"}}'); return; }
    res.setHeader("content-type", "application/json"); res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  const records: RoleRequestRecord[] = [];
  const p = await openRoleProxy({ role: "executor", endpoint: up.endpoint, model: "vision", apiKey: "k", thinking: false }, r => records.push(r));
  cleanup.push(p.close);
  const res = await post(p.connection);
  expect(res.status).toBe(200);
  expect(n).toBe(3);
  // 一次调用就是一次调用：重试不该在预算里记成三次。
  expect(records.filter(r => r.forwarded)).toHaveLength(1);
  expect(records[0]!.error).toBeUndefined();
});

it("上游一直 429 就如实交出去，不假装成功", async () => {
  const up = await upstream((res) => { res.setHeader("retry-after", "0"); res.statusCode = 429; res.setHeader("content-type", "application/json"); res.end('{"error":{"code":"hosted_shared_model_concurrency_limit"}}'); });
  const records: RoleRequestRecord[] = [];
  const p = await openRoleProxy({ role: "executor", endpoint: up.endpoint, model: "vision", apiKey: "k", thinking: false }, r => records.push(r));
  cleanup.push(p.close);
  expect((await post(p.connection)).status).toBe(429);
  expect(records[0]!.error).toMatch(/^upstream_http_429/);
});
