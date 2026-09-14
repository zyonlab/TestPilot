#!/usr/bin/env node
/**
 * 用测试钱包在 Hyperliquid testnet 上撤掉所有挂单（含触发单）——teardown 失手时的确定性兜底。
 *
 *   node fixtures/hyperliquid-testnet/cancel-all.mjs              # 撤全部挂单
 *   node fixtures/hyperliquid-testnet/cancel-all.mjs --flatten    # 再把持仓也平掉（reduce-only IOC，价格离 mark 5%）
 *
 * L1 动作的签名方式（照 Python SDK）：keccak(msgpack(action) ‖ nonce(u64 BE) ‖ 0x00) 当 connectionId，
 * 以 {source:"b"(testnet), connectionId} 做 EIP-712 Agent 签名，域 {Exchange, 1, chainId 1337}。
 * 仓库里没有 msgpack 库，这里手写了只覆盖 map/array/str/int/bool 的编码——够这个动作用，别拿去编别的。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(resolve("packages/harness-testing/package.json"));
const { Wallet, keccak256, concat, toBeArray, zeroPadValue } = require("ethers");

const INFO = "https://api.hyperliquid-testnet.xyz/info";
const EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";
const wallet = Wallet.fromPhrase(readFileSync(resolve("server/.wallets/seed.txt"), "utf8").trim());
const post = async (url, body) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

function msgpack(v) {
  const out = [];
  const enc = (x) => {
    if (x === null) return out.push(0xc0);
    if (x === true) return out.push(0xc3);
    if (x === false) return out.push(0xc2);
    if (typeof x === "number") {
      if (!Number.isInteger(x) || x < 0) throw new Error("only non-negative ints");
      if (x < 128) return out.push(x);
      if (x < 0x100) return out.push(0xcc, x);
      if (x < 0x10000) return out.push(0xcd, x >> 8, x & 0xff);
      if (x < 0x100000000) return out.push(0xce, ...[24, 16, 8, 0].map((s) => Number((BigInt(x) >> BigInt(s)) & 0xffn)));
      return out.push(0xcf, ...[56, 48, 40, 32, 24, 16, 8, 0].map((s) => Number((BigInt(x) >> BigInt(s)) & 0xffn)));
    }
    if (typeof x === "string") { const b = Buffer.from(x, "utf8"); if (b.length > 31) throw new Error("long str"); out.push(0xa0 | b.length, ...b); return; }
    if (Array.isArray(x)) { if (x.length > 15) throw new Error("long array"); out.push(0x90 | x.length); x.forEach(enc); return; }
    if (typeof x === "object") { const ks = Object.keys(x); if (ks.length > 15) throw new Error("big map"); out.push(0x80 | ks.length); for (const k of ks) { enc(k); enc(x[k]); } return; }
    throw new Error("unsupported " + typeof x);
  };
  enc(v);
  return new Uint8Array(out);
}

/** 签一个 L1 动作并发出去。 */
async function l1(action) {
  const nonce = Date.now();
  const connectionId = keccak256(concat([msgpack(action), zeroPadValue(toBeArray(nonce), 8), new Uint8Array([0])]));
  const sig = await wallet.signTypedData(
    { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    { source: "b", connectionId },
  );
  const r = "0x" + sig.slice(2, 66), s = "0x" + sig.slice(66, 130), v = parseInt(sig.slice(130, 132), 16);
  return post(EXCHANGE, { action, nonce, signature: { r, s, v } });
}

const meta = await post(INFO, { type: "meta" });
const assetIndex = Object.fromEntries(meta.universe.map((u, i) => [u.name, i]));
const open = await post(INFO, { type: "frontendOpenOrders", user: wallet.address });
console.log("address", wallet.address, "open orders", open.length);
if (open.length) {
  const res = await l1({ type: "cancel", cancels: open.map((o) => ({ a: assetIndex[o.coin], o: o.oid })) });
  console.log("cancel", JSON.stringify(res).slice(0, 200));
}
console.log("open orders after", (await post(INFO, { type: "frontendOpenOrders", user: wallet.address })).length);

if (process.argv.includes("--flatten")) {
  const state = await post(INFO, { type: "clearinghouseState", user: wallet.address });
  const mids = await post(INFO, { type: "allMids" });
  const positions = state.assetPositions.map((p) => p.position).filter((p) => Number(p.szi) !== 0);
  console.log("positions", positions.map((p) => `${p.coin} ${p.szi}`).join(", ") || "none");
  for (const p of positions) {
    const long = Number(p.szi) > 0;
    // 价格离 mark 5%（在 80% 带内、必成交），整数——BTC szDecimals=5，价格最多 1 位小数，取整最稳。
    const px = String(Math.round(Number(mids[p.coin]) * (long ? 0.95 : 1.05)));
    const order = { a: assetIndex[p.coin], b: !long, p: px, s: String(Math.abs(Number(p.szi))), r: true, t: { limit: { tif: "Ioc" } } };
    const res = await l1({ type: "order", orders: [order], grouping: "na" });
    console.log("close", p.coin, p.szi, "→", JSON.stringify(res).slice(0, 200));
  }
  const after = await post(INFO, { type: "clearinghouseState", user: wallet.address });
  console.log("positions after", after.assetPositions.length, "accountValue", after.marginSummary.accountValue);
}
