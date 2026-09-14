#!/usr/bin/env node
/**
 * tier4-demo：一个最小的合约下单面板 + mock 清算接口（07 T-15）。
 *
 * 被 coding agent **修改**的那个仓库。四个控件（Size / Price / Leverage / Place Order），
 * 一个 `/api/clearinghouse`（读）和 `/api/order`（写）。`kind: api` 判据打在 mock 接口上——不依赖 testnet，可复现。
 *
 * **故意留的 bug**：数量按 stepSize 四舍五入，交易所的规矩是截断（0.0016 → 0.001，不是 0.002）。
 * 修它的是 agent 的事；抓它的是 P0 第 1 条 + Stop hook。
 *
 *   node server.mjs [--port 5390]        # 静态页 + 接口
 *   POST /api/reset                      # 清仓（用例复位）
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 5390);
const STEP = 0.001; // BTC 的 szDecimals=3（demo 用 3 位，够看出四舍五入）
const TICK = 0.5;
const MAX_LEVERAGE = 40;

const state = { position: null, orders: [], leverage: 20, balance: 1000 };

/**
 * 数量按步长截断（交易所的规矩），不是四舍五入：0.0016 → 0.001。
 * 先把 raw/STEP 按 1e-9 抹掉浮点误差再 floor，不然 0.003/0.001 = 2.9999999999999996 会被截成 0.002。
 */
/** BUG：这里应该截断（Math.floor），却四舍五入了。 */
export const normalizeSize = (raw) => Math.round(raw / STEP) * STEP;
const normalizePrice = (raw) => Math.round(raw / TICK) * TICK;

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/clearinghouse") return json(res, 200, { balance: state.balance, leverage: state.leverage, position: state.position, orders: state.orders });
  if (url.pathname === "/api/reset" && req.method === "POST") { state.position = null; state.orders = []; state.leverage = 20; return json(res, 200, { ok: true }); }
  if (url.pathname === "/api/leverage" && req.method === "POST") {
    const { value } = await readBody(req);
    if (!(value >= 1 && value <= MAX_LEVERAGE)) return json(res, 400, { error: `leverage must be 1..${MAX_LEVERAGE}` });
    state.leverage = value; return json(res, 200, { leverage: value });
  }
  if (url.pathname === "/api/order" && req.method === "POST") {
    const { size, price, type } = await readBody(req);
    const sz = Number((normalizeSize(Number(size))).toFixed(3));
    if (!(sz > 0)) return json(res, 400, { error: "Size must be at least 0.001" });
    if (type === "limit") {
      const px = normalizePrice(Number(price));
      if (Math.abs(px - 80000) / 80000 > 0.8) return json(res, 400, { error: "Order price cannot be more than 80% away from the reference price" });
      state.orders.push({ oid: state.orders.length + 1, coin: "BTC", limitPx: px, sz });
      return json(res, 200, { ok: true, order: state.orders[state.orders.length - 1] });
    }
    const notional = sz * 80000;
    if (notional / state.leverage > state.balance) return json(res, 400, { error: "Not Enough Margin" });
    state.position = { coin: "BTC", szi: Number(((state.position?.szi ?? 0) + sz).toFixed(3)), leverage: state.leverage };
    return json(res, 200, { ok: true, position: state.position });
  }
  if (url.pathname === "/api/close" && req.method === "POST") { state.position = null; return json(res, 200, { ok: true }); }
  if (url.pathname === "/api/cancel" && req.method === "POST") { state.orders = []; return json(res, 200, { ok: true }); }
  if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(here, "public", "index.html"))); }
  json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`tier4-demo on http://127.0.0.1:${port}`));
