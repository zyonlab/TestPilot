/**
 * 接口判据：去问一个 JSON 接口，而不是看屏幕。
 *
 * 为什么要有它：交易页上最要紧的真值不在页面上。「开了一张 0.01 BTC 的多单」在屏幕上是一行
 * 会随行情变的文字，在交易所的清算接口里是一个精确的数（Hyperliquid：`clearinghouseState`
 * 的 `assetPositions[].position.szi`；CEX：持仓接口）。链上 dapp 的对应物是「钱包里多了一条
 * 成功交易」（`chain.ts`）；这一份是它在「有接口的产品」上的同构——**同样不问模型，
 * 同样是 tier 1/2**。
 *
 * BingX 那次是劫持接口把账户状态**写**成确定的；这里是只**读**接口把结果读成确定的。
 * 两条路一个目的：让判决落在程序能核对的数上。
 *
 * 纪律与 `oracle.ts` 一致：读不到（网络错、路径不存在、不是数）是 `unobservable`，
 * 不是 fail；两次观察之间的关系（increased/decreased/unchanged）是 tier 2。
 */
import type { ResolveContext } from "@testpilot/harness-core";
import { resolveText } from "@testpilot/harness-core";

export interface ApiOracleSpec {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  path: string;
  /** 取值前等多久。交易所的持仓/订单接口在下单后有传播延迟，不等会读到旧状态。 */
  settleMs?: number;
  unit?: { path: string; value: string };
  freshness?: { timestampPath: string; maxAgeMs: number };
}

/** 一次对接口的观察。`value` 是 `path` 指到的东西；读不到时 `error` 说明为什么。 */
export interface ApiObservation {
  value?: unknown;
  error?: string;
  httpStatus?: number;
}

/**
 * 点分路径取值：`assetPositions.0.position.szi`。任何一段落空就返回 undefined。
 *
 * 数组可以按字段选而不是按下标：`assetPositions[position.coin=BTC].position.szi`。
 * 交易所的持仓/挂单列表按币种排，下标随账户里有几个仓位而变——按下标写的判据
 * 换个账户就落空，而落空会被记成「测不到」，那是把判据自己的脆弱伪装成了环境问题。
 */
export function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const rawSeg of splitPath(path)) {
    if (rawSeg === "") continue;
    const sel = rawSeg.match(/^([^[]*)\[([^=\]]+)=([^\]]*)\]$/);
    const seg = sel ? sel[1] : rawSeg;
    if (seg !== "") {
      if (cur === null || cur === undefined) return undefined;
      if (Array.isArray(cur)) {
        const i = Number(seg);
        if (!Number.isInteger(i)) return undefined;
        cur = cur[i];
      } else if (typeof cur === "object") {
        cur = (cur as Record<string, unknown>)[seg];
      } else return undefined;
    }
    if (sel) {
      if (!Array.isArray(cur)) return undefined;
      const [, , key, want] = sel;
      const matches = cur.filter((el) => String(pick(el, key)) === want);
      if (matches.length > 1) throw new Error("API_SELECTOR_AMBIGUOUS");
      cur = matches[0];
    }
  }
  return cur;
}

/** 按 `.` 切段，但方括号里的 `.` 不切（`[position.coin=BTC]` 是一段）。 */
function splitPath(path: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of path) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "." && depth === 0) {
      out.push(buf);
      buf = "";
    } else buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * 去问接口。占位符（`${env.*}` / `${secret.*}`）在这里解析，所以密钥不会出现在用例文本里；
 * 出错信息里只带状态码和路径，不带响应体——响应体可能含账户信息。
 */
export async function observeApi(
  spec: ApiOracleSpec,
  ctx: ResolveContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiObservation> {
  const url = resolveText(spec.url, ctx);
  const method = spec.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = resolveText(v, ctx);
  let body: string | undefined;
  if (method === "POST") {
    body = spec.body ? resolveText(spec.body, ctx) : "{}";
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  if (spec.settleMs && spec.settleMs > 0) await new Promise((r) => setTimeout(r, spec.settleMs));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) return { error: `接口返回 HTTP ${res.status}`, httpStatus: res.status };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: "接口返回的不是 JSON", httpStatus: res.status };
    }
    if (spec.unit && pick(json, spec.unit.path) !== spec.unit.value) return { error: "接口单位不匹配或缺失", httpStatus: res.status };
    if (spec.freshness) {
      const timestamp = pick(json, spec.freshness.timestampPath), ms = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(ms) || Date.now() - ms > spec.freshness.maxAgeMs || ms - Date.now() > 5000) return { error: "接口状态时间缺失、过期或在未来", httpStatus: res.status };
    }
    const value = pick(json, spec.path);
    if (value === undefined) return { error: `响应里没有 ${spec.path}`, httpStatus: res.status };
    return { value, httpStatus: res.status };
  } catch (e) {
    return { error: (e as Error).message === "API_SELECTOR_AMBIGUOUS" ? "接口选择器匹配多个项目，无法确定目标" : `请求失败：${(e as Error).name === "AbortError" ? "超时" : "接口不可用"}` };
  } finally {
    clearTimeout(timer);
  }
}
