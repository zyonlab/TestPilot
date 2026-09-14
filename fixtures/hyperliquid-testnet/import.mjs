#!/usr/bin/env node
/**
 * 把 cases.json 导进一个 TestPilot 项目：建项目、建默认环境、逐条建用例。
 *
 *   node fixtures/hyperliquid-testnet/import.mjs --address 0x你的TEST_ACCOUNT [--gateway http://127.0.0.1:5301]
 *
 * 只走公开 API，不碰数据库；重复运行会再建一个同名项目——这是刻意的，
 * 一份基准的每次导入都该是一个干净的起点，而不是悄悄改掉上一份的用例。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const gateway = arg("--gateway", "http://127.0.0.1:5301");
const address = arg("--address");
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("需要 --address 0x…（注入钱包的地址，即 server/.wallets/account.txt）");
  process.exit(2);
}

const spec = JSON.parse(readFileSync(resolve(here, "cases.json"), "utf8"));
const post = async (path, body) => {
  const r = await fetch(gateway + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const { project } = await post("/api/projects", {
  name: `hyperliquid-testnet ${new Date().toISOString().slice(0, 10)}`,
  targetUrl: spec.environment.baseUrl,
  targetPlatform: "web",
});
console.log("project", project.id);

const env = spec.environment;
const { environment } = await post(`/api/projects/${project.id}/environments`, {
  name: env.name,
  baseUrl: env.baseUrl,
  vars: { ...env.vars, HL_ADDRESS: address },
  login: env.login,
  viewport: env.viewport,
  isDefault: true,
});
console.log("environment", environment.id, `viewport ${environment.viewport?.width ?? "?"}×${environment.viewport?.height ?? "?"}`);

for (const c of spec.cases) {
  const { case: created } = await post("/api/cases", { ...c, projectId: project.id, envRef: env.name });
  console.log("case", created.id, "·", c.priority, "·", c.title);
}
console.log(`\n导入完成。下一步：\n  1) 确认 ${address} 在 testnet 上有 mock USDC（README 里有领取条件）；\n  2) 先单跑第一条「连接注入钱包」，对照截图把 [首跑校对] 的文案改成逐字；\n  3) 再 Run all P0；跑完 node scripts/cost-report.mjs。`);
