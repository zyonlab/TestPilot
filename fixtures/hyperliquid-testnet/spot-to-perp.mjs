#!/usr/bin/env node
/**
 * 把测试钱包在 Hyperliquid testnet 上的 USDC 在现货/永续之间划转（usdClassTransfer）。
 *
 *   node fixtures/hyperliquid-testnet/spot-to-perp.mjs            # 现货 → 永续，全部
 *   node fixtures/hyperliquid-testnet/spot-to-perp.mjs --amount 500 [--to-spot]
 *
 * 为什么有它：2026-09-07 首次充值后 `clearinghouseState.accountValue` 是 999，跑完第 1 条
 * （只点了 Enable Trading / Establish Connection）它变成 0，钱在 `spotClearinghouseState`
 * 里——而 8 条用例的判据全读永续账户。签名用 `server/.wallets/seed.txt`，只在 testnet 用。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve("packages/harness-testing/package.json"));
const { Wallet } = require("ethers");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const toPerp = !args.includes("--to-spot");
const INFO = "https://api.hyperliquid-testnet.xyz/info";
const EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";

const wallet = Wallet.fromPhrase(readFileSync(resolve("server/.wallets/seed.txt"), "utf8").trim());
const info = async (body) =>
  (await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const before = {
  perp: (await info({ type: "clearinghouseState", user: wallet.address })).marginSummary.accountValue,
  spot: (await info({ type: "spotClearinghouseState", user: wallet.address })).balances.find((b) => b.coin === "USDC")?.total ?? "0",
};
console.log("address", wallet.address, "before", before);

const amount = arg("--amount", toPerp ? before.spot : before.perp);
if (!(Number(amount) > 0)) { console.error("没有可划转的余额"); process.exit(2); }

const nonce = Date.now();
const action = { type: "usdClassTransfer", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", amount: String(amount), toPerp, nonce };
const sig = await wallet.signTypedData(
  { name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" },
  { "HyperliquidTransaction:UsdClassTransfer": [
      { name: "hyperliquidChain", type: "string" },
      { name: "amount", type: "string" },
      { name: "toPerp", type: "bool" },
      { name: "nonce", type: "uint64" },
  ] },
  { hyperliquidChain: "Testnet", amount: String(amount), toPerp, nonce },
);
const r = "0x" + sig.slice(2, 66), s = "0x" + sig.slice(66, 130), v = parseInt(sig.slice(130, 132), 16);
const res = await fetch(EXCHANGE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature: { r, s, v } }) });
console.log("exchange", res.status, await res.text());

const after = {
  perp: (await info({ type: "clearinghouseState", user: wallet.address })).marginSummary.accountValue,
  spot: (await info({ type: "spotClearinghouseState", user: wallet.address })).balances.find((b) => b.coin === "USDC")?.total ?? "0",
};
console.log("after", after);
