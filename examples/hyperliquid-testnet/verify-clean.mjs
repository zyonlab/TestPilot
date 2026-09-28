#!/usr/bin/env node
/**
 * Hyperliquid 测试网账户的只读复核（docs/v3/15 阶段 5.4），给环境变量 TP_VERIFY_CLEAN_CMD 用：
 *
 *   TP_VERIFY_CLEAN_CMD="node examples/hyperliquid-testnet/verify-clean.mjs 0x<测试账户地址>"
 *
 * 执行或准备判「留下了资源、整批停」之前，服务端先跑它。退出码 0 = 账户上没有持仓也没有挂单（干净，不停批）；
 * 1 = 还有（停批，输出里列出来）；2 = 查不了（当作不知道，照样停批）。
 *
 * 它只读，而且只读测试网：这是环境卫生检查，不是用例判据——用例的判决照旧只从屏幕读（CLAUDE.md）。
 * 地址写死测试网：主网上同一个钱包有真钱，这里永远不该指向它。
 */
const INFO = "https://api.hyperliquid-testnet.xyz/info";
const user = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(user ?? "")) { console.error("usage: verify-clean.mjs 0x<address>"); process.exit(2); }
const ask = async (type) => {
  const res = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, user }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${type}: HTTP ${res.status}`);
  return res.json();
};
try {
  const [state, orders] = await Promise.all([ask("clearinghouseState"), ask("openOrders")]);
  const positions = (state.assetPositions ?? []).map((p) => p.position).filter((p) => Number(p.szi) !== 0);
  const pending = JSON.parse(process.env.TP_PENDING_RESOURCES ?? "[]");
  if (!positions.length && !orders.length) { console.log(`clean: 0 positions, 0 open orders (pending: ${pending.map((p) => p.identity).join(", ") || "-"})`); process.exit(0); }
  console.log(`dirty: ${positions.map((p) => `${p.coin} ${p.szi}`).join(", ") || "no positions"}; ${orders.map((o) => `${o.coin} ${o.side} ${o.sz}@${o.limitPx}`).join(", ") || "no open orders"}`);
  process.exit(1);
} catch (error) {
  console.error(`unknown: ${error.message}`);
  process.exit(2);
}
