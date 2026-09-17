// Placeholder resolution + secret redaction. Case steps store ${env.KEY} and
// ${secret.KEY} placeholders — never literal credentials. At run time we resolve
// them to real values for the browser, but LOG the original template text, so a
// plaintext secret never reaches logs, reports, or the DB.
// One row of a data-driven dataset: a primitive (${row}) or an object (${row.col}).
export type DataRow = string | number | boolean | Record<string, unknown>;

export interface ResolveContext {
  env: Record<string, string | string[]>; // non-secret vars (safe to show); may be arrays
  secrets: Record<string, string>; // sensitive values (must be redacted)
  row?: DataRow; // current data-driven row, if any → ${row} / ${row.col}
}

// ${env.KEY}, ${secret.KEY}, ${env.KEY.3} (array element), ${row}, or ${row.col}.
const PLACEHOLDER = /\$\{(env|secret|row)(?:\.([A-Za-z0-9_]+))?(?:\.(\d+))?\}/g;

// Resolve a template to its real value (for execution).
export function resolveText(text: string, ctx: ResolveContext): string {
  return text.replace(PLACEHOLDER, (whole, kind: string, key?: string, idx?: string) => {
    if (kind === "row") {
      const row = ctx.row;
      if (row === undefined) return whole;
      if (typeof row === "object") {
        if (!key) return JSON.stringify(row); // ${row} on an object → its JSON
        const v = (row as Record<string, unknown>)[key];
        return v === undefined ? whole : String(v); // ${row.col}
      }
      return key ? whole : String(row); // ${row} on a primitive; ${row.x} on a primitive → intact
    }
    if (!key) return whole; // env/secret require a key
    if (kind === "secret") return key in ctx.secrets ? ctx.secrets[key] : whole;
    const val = ctx.env[key];
    if (val === undefined) return whole; // leave unknown placeholders intact
    if (Array.isArray(val)) {
      // ${env.KEY.N} → the Nth element; ${env.KEY} on an array → comma-joined.
      if (idx !== undefined) return val[Number(idx)] ?? whole;
      return val.join(",");
    }
    return val;
  });
}

// Resolve every value of a key→template map (used for fixed headers / query params).
export function resolveMap(
  map: Record<string, string>,
  ctx: ResolveContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = resolveText(v, ctx);
  return out;
}

/**
 * 这段文字引用了哪些 `${env.X}` / `${secret.X}`。
 *
 * `resolveText` 对不认识的键**原样留着**——留着才看得出它没被解析。但没人查的话，
 * 一条引用了不存在变量的步骤会被照着字面送去执行：2026-09-16 实测，「打开 ${env.BASE_URL}/login」
 * 就这么原样进了浏览器动作规划。要在跑之前查出来，先得数得出它引用了什么。
 */
export function referencedKeys(text: string): { env: string[]; secret: string[] } {
  const env = new Set<string>(), secret = new Set<string>();
  let m: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(text))) {
    const key = m[2];
    if (!key) continue;
    if (m[1] === "secret") secret.add(key);
    else if (m[1] === "env") env.add(key);
  }
  return { env: [...env], secret: [...secret] };
}

// True if the template references a secret placeholder (so we know to keep the
// template out of any resolved log line).
export function hasSecretRef(text: string): boolean {
  let m: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(text))) if (m[1] === "secret") return true;
  return false;
}

// Defense-in-depth: mask any raw secret value that slipped into a string
// (e.g. an error message echoing an input). Longest values first.
export function redact(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join("••••••");
  }
  return out;
}
