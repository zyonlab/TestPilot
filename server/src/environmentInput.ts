/**
 * 一次环境保存请求里，**这次真的说了**哪些字段。
 *
 * 抽出来是因为它被一次真实的数据损坏证明过：2026-09-16 只发 `{name, vars}` 去加两个变量，
 * 被测对象的地址与三步登录流程当场被清空，接口还回 200——路由把缺席的字段补成了空值
 * （`baseUrl ?? ""`、`login ?? {}`），于是 `upsertEnvironment` 里「没给就沿用已存的」永远轮不到。
 * **少一个字段是「这次没说」，不是「置空」**；要置空就显式发一个空值（`baseUrl: ""`）。
 *
 * 放在自己的文件里，是为了能单独测：整个网关 app 在测试里起不起来，而这段逻辑必须有钉子。
 */
export interface EnvironmentBody {
  baseUrl?: unknown; vars?: unknown; headers?: unknown; query?: unknown; login?: unknown;
  isDefault?: unknown; viewport?: unknown; visualThresholdPct?: unknown;
  capabilities?: unknown; injectWallet?: unknown; allowIrreversible?: unknown;
}

export function environmentPatch(body: EnvironmentBody) {
  const { baseUrl, vars, headers, query, login, isDefault, viewport, visualThresholdPct, capabilities, injectWallet, allowIrreversible } = body;
  /*
   * 视口曾经一直被丢掉：界面发了 `viewport`，`upsertEnvironment` 也收，而路由的解构没有它。
   * 只收合法的数：一个 `{}` 或字符串会让 `viewportJson` 看起来像配过了，而它什么都没说。
   */
  const vp = viewport && typeof viewport === "object"
    ? { ...(Number((viewport as { width?: unknown }).width) > 0 ? { width: Math.round(Number((viewport as { width?: unknown }).width)) } : {}),
        ...(Number((viewport as { height?: unknown }).height) > 0 ? { height: Math.round(Number((viewport as { height?: unknown }).height)) } : {}) }
    : undefined;
  // 视觉阈值：只收 0–100 的数，`0` 有意义（逐像素必须相同），所以不能用真值判断。
  const vt = Number(visualThresholdPct);
  return {
    ...(Number.isFinite(vt) && vt >= 0 && vt <= 100 ? { visualThresholdPct: vt } : {}),
    ...(typeof baseUrl === "string" ? { baseUrl } : {}),
    ...(vars && typeof vars === "object" ? { vars: vars as Record<string, string> } : {}),
    ...(headers && typeof headers === "object" ? { headers: headers as Record<string, string> } : {}),
    ...(query && typeof query === "object" ? { query: query as Record<string, string> } : {}),
    ...(vp && (vp.width || vp.height) ? { viewport: vp } : {}),
    // 没有 `session` 这一项 → upsert 保留已抓到的会话。
    ...(login && typeof login === "object" ? { login: login as Record<string, unknown> } : {}),
    ...(typeof isDefault === "boolean" ? { isDefault } : {}),
    // 环境画像：前提名、默认注入钱包、允许不可逆操作。都由人在环境设置里填，不给就沿用已存的。
    ...(Array.isArray(capabilities) ? { capabilities: capabilities.map(String).map((c: string) => c.trim()).filter(Boolean) } : {}),
    ...(typeof injectWallet === "boolean" ? { injectWallet } : {}),
    ...(typeof allowIrreversible === "boolean" ? { allowIrreversible } : {}),
  };
}
