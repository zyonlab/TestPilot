import { expect, it } from 'vitest';
import { executorPreflight } from '../src/modelPreflight.js';

// docs/v3/15 阶段 5.1：2026-09-27～28 三次跑到一半才撞上执行模型额度。开跑前探一次，只在端点明确说不时拦。
const c = { endpoint: 'https://model.example/v1/', model: 'm', apiKey: 'sk-secret-123' };
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

it('stops on an explicit refusal and brings back what the provider said, without the key', async () => {
  const v = await executorPreflight(c, reply(429, { error: { message: "You've used this period's free allowance (key sk-secret-123)." } }));
  expect(v).toEqual({ ok: false, status: 429, message: "You've used this period's free allowance (key [redacted])." });
  expect(await executorPreflight(c, reply(402, {}))).toMatchObject({ ok: false, status: 402, message: 'HTTP 402' });
});
it('lets the run go on success, on other errors, and when the endpoint cannot be reached', async () => {
  expect(await executorPreflight(c, reply(200, { choices: [] }))).toEqual({ ok: true });
  expect(await executorPreflight(c, reply(500, {}))).toEqual({ ok: true });
  expect(await executorPreflight(c, (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch)).toEqual({ ok: true });
});
it('calls the chat endpoint with a one-token request', async () => {
  let seen: { url?: string; body?: any } = {};
  await executorPreflight(c, (async (url: string, init: RequestInit) => { seen = { url, body: JSON.parse(String(init.body)) }; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch);
  expect(seen.url).toBe('https://model.example/v1/chat/completions');
  expect(seen.body).toMatchObject({ model: 'm', max_tokens: 1 });
});
