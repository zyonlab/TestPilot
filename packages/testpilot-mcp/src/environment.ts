/**
 * 被测环境从 **TestPilot 的环境记录**来，不从工具参数里现编。
 *
 * 一个 `target: "https://..."` 参数看起来够用，直到你要跑一个**要登录**的产品：
 * 那时真正决定这次执行的是会话 cookie、视口、固定请求头、`${env.*}` 的取值——
 * 全都躺在网关那张 `environments` 表里，是人在界面上一次次配出来的。
 * 让工具的调用方把它们重打一遍，等于让 agent 去猜一份它看不见的配置，
 * 而猜错的表现是「产品把我登出了」，不是一条报错。
 *
 * 两个来源，各取所长：
 *
 * - **非机密部分走 HTTP**（`GET :5301/api/projects/<id>/environments`）：网关是这份记录的
 *   主人，读它的 API 才读得到「现在是什么」，读文件会读到一份可能过期的快照。
 * - **会话走数据库**：那个 API **有意**不回传 storageState（只给 `hasSession`），
 *   而 29 条 cookie 是这次执行能不能进得去的全部。所以直接读
 *   `.data/testpilot.db` 的 `sessionEnc`，用 `.data/secret.key` 解（AES-256-GCM，
 *   `iv(12)||tag(16)||ct`，与 `server/src/vault.ts` 同一套）。
 *
 * 解出来的会话**不出这个进程**：它只被交给 `executeRun`，一个字节都不进返回值、
 * 不进日志、不进 `runs/`。
 */
import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 网关默认在哪。可以被 `apiBase` 覆盖——自举时被测的那个网关在另一个端口上。 */
export const DEFAULT_API_BASE = "http://127.0.0.1:5301";

/**
 * 视口：这个被测对象要多大的一块屏。
 *
 * 默认 1600×1000 而不是 `harness-testing/env.ts` 的 1024×720：后者是为了压小视觉模型的
 * 图定的，而一个交易终端在 1024 宽下会把下单面板整个折叠起来——探索走不到的那些屏，
 * 不是产品没有，是我们没给它地方长出来。
 */
export const DEFAULT_VIEWPORT = { width: 1600, height: 1000 };

export interface ResolvedEnvironment {
  id: string;
  name: string;
  baseUrl: string;
  vars: Record<string, string | string[]>;
  headers: Record<string, string>;
  query: Record<string, string>;
  viewport: { width: number; height: number };
  /** 解出来的登录态。**不要放进任何返回值。** */
  session: unknown | null;
  /** 会话是从哪儿来的，或者为什么没有。这一句要能进报告，会话本身不能。 */
  sessionSource: string;
  /** 这次执行打给哪个视觉模型。执行侧不接受「不知道」——见 `requireModelEndpoint`。 */
  model: { baseUrl: string; model: string };
  /**
   * 一个持续登录的浏览器 profile 目录，用它启动就不再靠 replay cookie。
   * 来源两处，按优先级：环境记录里的 `login.sutProfileDir`，或 `TP_SUT_PROFILE` 环境变量。
   * 解析到但目录不存在时**报错而不是静默忽略**——否则会悄悄退回到那条过不了墙的注入路径。
   */
  sutProfileDir: string | null;
}

interface EnvRecord {
  id: string;
  name: string;
  baseUrl?: string;
  vars?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  viewport?: { width?: number; height?: number };
  isDefault?: boolean;
  login?: { hasSession?: boolean; authRequired?: boolean; sutProfileDir?: string };
}

/** 网关那份记录。读不到就说清是读不到，别退回一个空环境接着跑。 */
async function fetchEnvironments(apiBase: string, projectId: string): Promise<EnvRecord[]> {
  const url = `${apiBase.replace(/\/$/, "")}/api/projects/${encodeURIComponent(projectId)}/environments`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(`cannot reach the TestPilot gateway at ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`${url} returned ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { environments?: EnvRecord[] };
  return body.environments ?? [];
}

/** 网关数据目录。与 `server/src/datadir.ts` 同一条规则：`TP_DATA_DIR` 优先。 */
export function dataDir(repoRoot: string): string {
  return process.env.TP_DATA_DIR ? resolve(process.env.TP_DATA_DIR) : resolve(repoRoot, "server", ".data");
}

/**
 * 解开一条 `sessionEnc`。
 *
 * 密钥读不到、密文对不上，都返回 `undefined` 而不是抛：一次**没有**登录态的执行仍然
 * 是一次可以做的执行（它会在登录墙前失败，而那是一个清楚的结果）；
 * 而一个因为解密失败就崩掉的工具，会让人以为是用例的问题。
 */
export function decryptSession(blob: string, keyPath: string): unknown | undefined {
  if (!blob) return undefined;
  if (!existsSync(keyPath)) return undefined;
  try {
    const key = readFileSync(keyPath);
    if (key.length !== 32) return undefined;
    const buf = Buffer.from(blob, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 从网关的库里取这条环境的登录态。
 *
 * 用 Node 24 自带的 `node:sqlite`，不引 `better-sqlite3`：后者是个要编译的原生依赖，
 * 为了读一列密文把它拖进 MCP 包，代价和收益完全不成比例。
 */
export function readSessionBlob(envId: string, dir: string): { blob: string; dbPath: string } {
  const dbPath = resolve(dir, "testpilot.db");
  if (!existsSync(dbPath)) return { blob: "", dbPath };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT sessionEnc FROM environments WHERE id = ?").get(envId) as
      | { sessionEnc?: string }
      | undefined;
    return { blob: row?.sessionEnc ?? "", dbPath };
  } finally {
    db.close();
  }
}

/**
 * 执行侧的模型端点必须是**明说的**。
 *
 * Midscene 找不到端点时不会停，它会退到一份内置默认值上，然后每一步定位都失败，
 * 而失败看起来像「产品上没有这个控件」——一个被测产品的假缺陷。所以这里当场拦下来。
 */
export function requireModelEndpoint(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; model: string } {
  const baseUrl = env.MIDSCENE_MODEL_BASE_URL ?? env.OPENAI_BASE_URL;
  const model = env.MIDSCENE_MODEL_NAME;
  if (!baseUrl || !model)
    throw new Error(
      "the execution model endpoint is not set: MIDSCENE_MODEL_BASE_URL (or OPENAI_BASE_URL) and MIDSCENE_MODEL_NAME " +
        "must both be present. Without them Midscene falls back to a built-in default and every grounding step fails, " +
        "which reads as a defect in the product under test rather than a misconfiguration.",
    );
  return { baseUrl, model };
}

export interface ResolveEnvironmentOptions {
  /** 环境 id 或名字。留空取项目的默认环境。 */
  env?: string;
  projectId?: string;
  apiBase?: string;
  /** 直接给 URL，绕过环境记录。给了它就不去问网关。 */
  target?: string;
  viewport?: { width?: number; height?: number };
  repoRoot: string;
}

/**
 * 解析持续 profile 目录:记录 > 环境变量。解到了但目录不在就抛,不静默回落到注入路径——
 * 那条路径对这类站点是坏的,悄悄走回去等于把一次"没登录"伪装成产品缺陷。
 */
function resolveSutProfile(recordDir: string | undefined): string | null {
  const raw = recordDir || process.env.TP_SUT_PROFILE || "";
  if (!raw) return null;
  const dir = resolve(raw);
  if (!existsSync(dir))
    throw new Error(
      `sutProfileDir is set to ${dir} but that directory does not exist. A persistent login profile must be ` +
        `created first (log in once in that profile), otherwise execution would silently fall back to cookie ` +
        `injection, which does not authenticate on this kind of site.`,
    );
  return dir;
}

export async function resolveEnvironment(opts: ResolveEnvironmentOptions): Promise<ResolvedEnvironment> {
  const model = requireModelEndpoint();

  // 只给了 URL：一个没有会话、没有变量的裸目标。够用于内置 fixture，不够用于要登录的产品，
  // 所以它如实把 `sessionSource` 说成「没问过环境记录」。
  if (opts.target && !opts.env) {
    if (!/^https?:\/\//.test(opts.target)) throw new Error(`target must be an http(s) URL, got "${opts.target}"`);
    return {
      id: "(ad-hoc)",
      name: "(ad-hoc)",
      baseUrl: opts.target,
      vars: {},
      headers: {},
      query: {},
      viewport: { ...DEFAULT_VIEWPORT, ...opts.viewport },
      session: null,
      sessionSource: "none — a bare target URL was given, so no environment record was consulted",
      model,
      sutProfileDir: resolveSutProfile(undefined),
    };
  }

  if (!opts.projectId)
    throw new Error("resolving an environment needs projectId (the TestPilot project the environment belongs to)");

  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const records = await fetchEnvironments(apiBase, opts.projectId);
  if (!records.length) throw new Error(`project ${opts.projectId} has no environments configured in ${apiBase}`);
  const record = opts.env
    ? records.find((e) => e.id === opts.env || e.name === opts.env)
    : (records.find((e) => e.isDefault) ?? records[0]);
  if (!record)
    throw new Error(
      `no environment "${opts.env}" in project ${opts.projectId} — it has: ${records.map((e) => e.name).join(", ")}`,
    );

  const dir = dataDir(opts.repoRoot);
  const { blob, dbPath } = readSessionBlob(record.id, dir);
  const session = decryptSession(blob, resolve(dir, "secret.key"));
  const sessionSource = session
    ? `decrypted from ${dbPath} (environments.sessionEnc)`
    : record.login?.hasSession
      ? `the record says it has a session, but it could not be decrypted from ${dbPath} — check .data/secret.key`
      : "the environment record holds no captured session";

  return {
    id: record.id,
    name: record.name,
    baseUrl: opts.target ?? record.baseUrl ?? "",
    vars: record.vars ?? {},
    headers: record.headers ?? {},
    query: record.query ?? {},
    // 记录里配了就听记录的；没配就用 1600×1000，而不是执行侧那个为省图省下来的 1024×720。
    viewport: {
      width: opts.viewport?.width ?? record.viewport?.width ?? DEFAULT_VIEWPORT.width,
      height: opts.viewport?.height ?? record.viewport?.height ?? DEFAULT_VIEWPORT.height,
    },
    session: session ?? null,
    sessionSource,
    model,
    sutProfileDir: resolveSutProfile(record.login?.sutProfileDir),
  };
}

/** 能进报告的那一份。**没有 session，也没有请求头的值**——头的名字可以说，值不行。 */
export function describeEnvironment(env: ResolvedEnvironment): Record<string, unknown> {
  return {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    viewport: env.viewport,
    varKeys: Object.keys(env.vars).sort(),
    headerKeys: Object.keys(env.headers).sort(),
    query: env.query,
    hasSession: !!env.session,
    sessionSource: env.sessionSource,
    // 用了持续 profile 就以它为准——报告里说明会话来自 profile 而非注入。
    sutProfile: env.sutProfileDir ? { dir: env.sutProfileDir, note: "driving on a persistent logged-in profile; storageState injection is bypassed" } : null,
    model: env.model,
  };
}
