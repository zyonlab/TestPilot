import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * 2026-09-24：规划宿主能跑 node/curl，裸 HTTP 不带头就被 reviewerPrincipal 当成人。
 * 宿主进程树里默认的发请求方式都要自动带 x-testpilot-actor；已经带了的不覆盖；别的主机不碰。
 */
let dir: string, server: Server, url = "", seen: Array<string | undefined> = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-actor-")); vi.stubEnv("TP_DATA_DIR", dir);
  server = createServer((req, res) => { seen.push(req.headers["x-testpilot-actor"] as string | undefined); res.end("ok"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(r => server.close(r)); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

// 异步起子进程：测试自己的 HTTP 服务在同一进程里，同步等会把自己锁死。
const node = (code: string, env: Record<string, string>) =>
  run(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env } });

it("tags node fetch and http.request to the TestPilot server, keeps an existing actor, leaves other origins alone", async () => {
  const { hostActorEnv, HOST_ACTOR } = await import("../src/runtime/hostActorTag.js");
  const env = hostActorEnv(url, {});
  seen = [];
  await node(`await fetch(${JSON.stringify(url + "/api/x")}, {method:'POST'});`, env);
  await node(`import http from 'node:http'; await new Promise(r=>http.request(${JSON.stringify(url + "/y")},{method:'POST'},res=>{res.resume();res.on('end',r);}).end());`, env);
  await node(`await fetch(${JSON.stringify(url + "/z")}, {headers:{'x-testpilot-actor':'agent'}});`, env);
  expect(seen).toEqual([HOST_ACTOR, HOST_ACTOR, "agent"]);
  seen = [];
  const other = url.replace("127.0.0.1", "localhost").replace(/:\d+$/, ":1");
  await node(`await fetch(${JSON.stringify(other)}).catch(()=>{}); await fetch(${JSON.stringify(url)}, {});`, { ...env, NODE_OPTIONS: env.NODE_OPTIONS });
  expect(seen).toEqual([HOST_ACTOR]);
});

it("tags curl through CURL_HOME", async () => {
  const { hostActorEnv, HOST_ACTOR } = await import("../src/runtime/hostActorTag.js");
  const env = hostActorEnv(url, {});
  seen = [];
  await run("curl", ["-s", "-X", "POST", url + "/api/approve"], { env: { ...process.env, ...env } });
  expect(seen).toEqual([HOST_ACTOR]);
});

it("reviewerPrincipal refuses a tagged request", async () => {
  const { reviewerPrincipal } = await import("../src/reviewPrincipal.js");
  expect(() => reviewerPrincipal({ headers: { "x-testpilot-actor": "planner-host" } })).toThrow(/operator_action_required/);
  expect(reviewerPrincipal({ headers: {} })).toMatchObject({ kind: "human" });
});
