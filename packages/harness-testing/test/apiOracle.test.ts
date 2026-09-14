import { describe, expect, it } from "vitest";
import { evaluateOracle, MachineOracleSchema, tierOf, type PageSnapshot } from "../src/exec/oracle.js";
import { observeApi, pick } from "../src/exec/apiOracle.js";

/**
 * 接口判据：去问一个 JSON 接口，而不是看屏幕。
 *
 * 场景取自 Hyperliquid testnet 的 `clearinghouseState`：持仓量 `szi` 是字符串形式的数
 * （"0.01"），挂单在 `openOrders` 里是数组。交易页的真值长这样，不长在屏幕上。
 */

const api = (value: unknown, error?: string): PageSnapshot => ({ text: "", url: "https://app/trade", api: error ? { error } : { value } });
const hl = { url: "https://api.hyperliquid-testnet.xyz/info", method: "POST" as const, body: '{"type":"clearinghouseState","user":"${env.HL_ADDRESS}"}' };

describe("pick：点分路径", () => {
  it("走对象和数组下标；任何一段落空返回 undefined 而不是抛", () => {
    const state = { assetPositions: [{ position: { coin: "BTC", szi: "0.01" } }] };
    expect(pick(state, "assetPositions.0.position.szi")).toBe("0.01");
    expect(pick(state, "assetPositions.1.position.szi")).toBeUndefined();
    expect(pick(state, "assetPositions.0.position.szi.x")).toBeUndefined();
    expect(pick(null, "a")).toBeUndefined();
  });
  it("数组按字段选：持仓列表按币种找，不按会变的下标", () => {
    const state = {
      assetPositions: [
        { position: { coin: "ETH", szi: "0.5" } },
        { position: { coin: "BTC", szi: "0.01" } },
      ],
    };
    expect(pick(state, "assetPositions[position.coin=BTC].position.szi")).toBe("0.01");
    expect(pick(state, "assetPositions[position.coin=SOL].position.szi")).toBeUndefined();
    expect(pick({ orders: [{ coin: "BTC", oid: 7 }] }, "orders[coin=BTC].oid")).toBe(7);
  });
});

describe("tier", () => {
  it("eq/gte/exists 是 1，前后比较是 2——和 delta 同一条线", () => {
    expect(tierOf({ kind: "api", ...hl, path: "x", op: "eq", value: 1 })).toBe(1);
    expect(tierOf({ kind: "api", ...hl, path: "x", op: "exists" })).toBe(1);
    expect(tierOf({ kind: "api", ...hl, path: "x", op: "increased" })).toBe(2);
  });
  it("schema 收下它，并给 method 默认值", () => {
    const parsed = MachineOracleSchema.parse({ kind: "api", url: "https://x", path: "a.b", op: "eq", value: "1" });
    expect(parsed).toMatchObject({ kind: "api", method: "GET" });
  });
});

describe("evaluateOracle：api", () => {
  it("eq：数字字符串和数按数比——\"0.01\" 等于 0.01", () => {
    const o = { kind: "api" as const, ...hl, path: "assetPositions.0.position.szi", op: "eq" as const, value: 0.01 };
    expect(evaluateOracle(o, api("0.01")).status).toBe("pass");
    expect(evaluateOracle(o, api("0.02")).status).toBe("fail");
    expect(evaluateOracle(o, api("0.01")).detail).toContain("0.01");
  });
  it("gte/lte 遇到不是数的值：unobservable，不是 fail", () => {
    const o = { kind: "api" as const, ...hl, path: "p", op: "gte" as const, value: 1 };
    expect(evaluateOracle(o, api("abc")).status).toBe("unobservable");
  });
  it("读不到（网络错、路径落空）是 unobservable——harness 没量到，不是产品错了", () => {
    const o = { kind: "api" as const, ...hl, path: "p", op: "eq" as const, value: 1 };
    expect(evaluateOracle(o, api(undefined, "请求失败：超时")).status).toBe("unobservable");
    expect(evaluateOracle(o, { text: "", url: "u" }).status).toBe("unobservable");
  });
  it("null 也算没有：absent 对 null 通过，exists 对 null 失败（tier4-demo 的 mock 平仓后 position 是 null）", () => {
    const abs = { kind: "api" as const, ...hl, path: "position", op: "absent" as const };
    expect(evaluateOracle(abs, { text: "", url: "", api: { value: null, httpStatus: 200 } } as never).status).toBe("pass");
    const ex = { kind: "api" as const, ...hl, path: "position", op: "exists" as const };
    expect(evaluateOracle(ex, { text: "", url: "", api: { value: null, httpStatus: 200 } } as never).status).toBe("fail");
  });

  it("absent 是唯一把「路径落空」当成结果的判据：撤单后 openOrders.0 应该不存在", () => {
    const o = { kind: "api" as const, ...hl, path: "openOrders.0", op: "absent" as const };
    expect(evaluateOracle(o, api(undefined, "响应里没有 openOrders.0")).status).toBe("pass");
    expect(evaluateOracle(o, api({ oid: 1 })).status).toBe("fail");
    expect(evaluateOracle(o, api(undefined, "请求失败：超时")).status).toBe("unobservable");
  });
  it("increased：需要前后两次读数；开仓后 szi 从 0 到 0.01", () => {
    const o = { kind: "api" as const, ...hl, path: "assetPositions.0.position.szi", op: "increased" as const, by: 0.01 };
    expect(evaluateOracle(o, api("0.01"), api("0")).status).toBe("pass");
    expect(evaluateOracle(o, api("0.02"), api("0")).status).toBe("fail");
    expect(evaluateOracle(o, api("0.01")).status).toBe("unobservable");
    expect(evaluateOracle(o, api("0.01"), api(undefined, "请求失败")).status).toBe("unobservable");
  });
  it("unchanged：一键平仓失败时持仓不该变", () => {
    const o = { kind: "api" as const, ...hl, path: "assetPositions.0.position.szi", op: "unchanged" as const };
    expect(evaluateOracle(o, api("0.01"), api("0.01")).status).toBe("pass");
    expect(evaluateOracle(o, api("0"), api("0.01")).status).toBe("fail");
  });
});

describe("observeApi", () => {
  const ctx = { env: { HL_ADDRESS: "0xabc" }, secrets: {} };
  const fake = (status: number, body: unknown, capture?: (init: RequestInit, url: string) => void): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      capture?.(init ?? {}, String(url));
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;

  it("POST：占位符在正文里解析，密钥不进用例文本", async () => {
    let seen: { init: RequestInit; url: string } | undefined;
    const obs = await observeApi(
      { ...hl, path: "assetPositions.0.position.szi" },
      ctx,
      fake(200, { assetPositions: [{ position: { szi: "0.01" } }] }, (init, url) => (seen = { init, url })),
    );
    expect(obs.value).toBe("0.01");
    expect(seen?.init.method).toBe("POST");
    expect(String(seen?.init.body)).toContain('"user":"0xabc"');
    expect(seen?.url).toBe(hl.url);
  });
  it("HTTP 错、非 JSON、路径落空：各自一句话的 error，不带响应体", async () => {
    expect((await observeApi({ ...hl, path: "a" }, ctx, fake(502, "bad gateway"))).error).toBe("接口返回 HTTP 502");
    expect((await observeApi({ ...hl, path: "a" }, ctx, fake(200, "<html>"))).error).toBe("接口返回的不是 JSON");
    expect((await observeApi({ ...hl, path: "a.b" }, ctx, fake(200, { a: {} }))).error).toBe("响应里没有 a.b");
  });
});
it('distinguishes decimal values beyond binary precision and never hides a small financial change with epsilon', () => {
 const base = { kind: 'api' as const, ...hl, path: 'balance', op: 'eq' as const, value: '9007199254740993' };
 expect(evaluateOracle(base, api('9007199254740992')).status).toBe('fail');
 expect(evaluateOracle({ ...base, value: '0.000000000001' }, api('1e-12')).status).toBe('pass');
 expect(evaluateOracle({ ...base, op: 'increased', by: '0.000000000001' }, api('0.000000000002'), api('0')).status).toBe('fail');
 expect(evaluateOracle({ ...base, op: 'increased', by: '0.1' }, api('0.3'), api('0.2')).status).toBe('pass');
 expect(evaluateOracle({ ...base, value: 9007199254740992 }, api('9007199254740992')).status).toBe('unobservable');
 expect(evaluateOracle({ ...base, value: true }, api('true')).status).toBe('fail');
});
it('ambiguous currency selection, wrong unit and stale state cannot become absence passes', async () => {
 const response = (body:unknown) => (async () => new Response(JSON.stringify(body))) as typeof fetch;
 const spec = { url:'https://fixture.test',path:'positions[coin=BTC].size' };
 const obs = await observeApi(spec,{env:{},secrets:{}},response({positions:[{coin:'BTC',size:'1'},{coin:'BTC',size:'2'}]}));
 expect(obs.error).toContain('多个'); expect(evaluateOracle({kind:'api',...spec,method:'GET',op:'absent'},api(undefined,obs.error)).status).toBe('unobservable');
 expect((await observeApi({...spec,path:'balance',unit:{path:'currency',value:'USDC'}},{env:{},secrets:{}},response({balance:'10',currency:'BTC'}))).error).toContain('单位');
 expect((await observeApi({...spec,path:'balance',freshness:{timestampPath:'at',maxAgeMs:1000}},{env:{},secrets:{}},response({balance:'10',at:Date.now()-10000}))).error).toContain('过期');
});
