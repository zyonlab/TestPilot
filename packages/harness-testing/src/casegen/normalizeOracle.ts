/**
 * 把「扁平、全必填」schema 下模型交回来的 oracle 剥成 zod 认的形状（07 T-12，2026-09-08）。
 *
 * 为什么 schema 要全必填：runinfra 的 qwen3-8-27b 在约束解码下一律跳过可选键——连 `oracle` 本身都跳，
 * `anyOf` 按 kind 分支又会让解码器在 `value` 里把后面的字段全写进去。所以 schema 里 text 类 oracle
 * 也带着 `url` / `method` / `path` / `op` / `settleMs`，值是占位符（"-" / "GET" / "eq" / 0）。
 * 这里在 zod 之前把它们剥掉；`kind: "none"`（tier 3）剥成没有 oracle。
 * 见 `prompts.ts` 里 `CASES_SCHEMA.oracle` 那段注释与 `test/normalizeOracle.test.ts`。
 */
const FILLER = new Set(["-", "", "GET", "eq"]);
const isFiller = (v: unknown): boolean => v === undefined || v === null || v === 0 || (typeof v === "string" && FILLER.has(v.trim()));

const KEEP: Record<string, readonly string[]> = {
  text: ["kind", "value"],
  noText: ["kind", "value"],
  url: ["kind", "value"],
  count: ["kind", "value", "op", "n"],
  delta: ["kind", "value", "direction", "by"],
  api: ["kind", "url", "method", "body", "headers", "path", "op", "value", "by", "settleMs", "unit", "freshness"],
};

export function normalizeOracle(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "";
  if (!kind || kind === "none") return undefined;
  const keep = KEEP[kind];
  if (!keep) return raw; // 不认识的 kind 原样交给 zod 去拒
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    const v = o[k];
    if (k === "kind" || k === "value") {
      out[k] = v;
      continue;
    }
    if (kind === "api") {
      // api 的 body 是可选的：占位符 "-" 等于没给。op / method / path 要留着让 zod 判。
      if (k === "body" && isFiller(v)) continue;
      if (k === "by" && isFiller(v)) continue;
      if (v !== undefined) out[k] = v;
      continue;
    }
    if (v !== undefined && !(isFiller(v) && k !== "op")) out[k] = v;
    // count 的 op 默认 eq，模型填 "eq" 不是占位符——上面那行把 op 留下了（isFiller 对 op 不生效）
  }
  if (kind === "api" && out.value === "-") delete out.value;
  return out;
}

/** 给 zod：`z.preprocess(normalizeCase, TextCaseSchema)`。 */
export function normalizeCase(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const c = raw as Record<string, unknown>;
  if (!("oracle" in c)) return raw;
  const oracle = normalizeOracle(c.oracle);
  const { oracle: _drop, ...rest } = c;
  return oracle === undefined ? rest : { ...rest, oracle };
}
