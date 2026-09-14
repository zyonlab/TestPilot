import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./datadir.js";
import { decryptSecret, encryptSecret } from "./vault.js";

/**
 * 模型配置的**落盘覆盖层**。
 *
 * 存在的理由是一处一直在发生的事：配置页什么都不保存（四个值写死在内存 store 里，
 * 刷新即丢），而真实运行的端点来自环境变量——于是界面上填什么都不影响任何一次运行。
 * 更糟的是同一份 env 有**两条互不相干的解析路**，它们对空字符串的处理还相反：
 * 网关侧用 `||`（空串继续下落、兜底 `"1234"`），运行侧用 `??`（空串是有效值、兜底 `""`）。
 * 于是 `.env` 里一行空的 `OPENAI_API_KEY=` 就能让**探活报绿而运行 401**，
 * 而 401 读起来像模型服务坏了。
 *
 * 这一层的三条纪律：
 *
 * ① **每个字段都可缺省，且绝不写空串占位。** 缺省就是「这一项没配」，
 *    让解析穿透到 env——「不配置就原样回落今天的行为」不是靠额外的 if，
 *    是靠字段根本不存在。
 * ② **密钥密文存。** 用仓库已有的 `encryptSecret`（AES-256-GCM，密钥在 `.data/secret.key`
 *    mode 0600）。明文永不落盘，也永不出服务端——读接口只回「配没配、什么时候改的」。
 * ③ **写盘失败要抛。** `settings.ts` 的 `persist` 是 try/catch 吞掉的 best effort，
 *    那对提示词模板可以，对模型配置不行：接口返回成功而盘上没写，
 *    下一次运行仍然用旧端点，而人以为改过了。
 */
export interface SavedModelConfig {
  baseUrl?: string;
  modelName?: string;
  /** 密文。明文永远不出现在这个文件里，也永远不出现在任何接口的返回里。 */
  apiKeyEnc?: string;
  /** 发给端点的思考开关。注意端点认不认是另一回事——见界面上的说明。 */
  think?: boolean;
  thinkBudget?: number;
  timeoutMs?: number;
  /** Qwen VL 系列的坐标定位模式。此前它是前端按模型名正则猜出来的。 */
  useQwenVL?: boolean;
  updatedAt?: string;
}

const PATH = dataPath("model.json");
let cache: SavedModelConfig | null = null;

/** 读盘一次。文件不存在、坏了、解不开，一律当作「没配」——绝不因此把配置页打死。 */
export function getSavedModelConfig(): SavedModelConfig {
  if (cache) return cache;
  let loaded: SavedModelConfig = {};
  try {
    if (existsSync(PATH)) loaded = JSON.parse(readFileSync(PATH, "utf8")) as SavedModelConfig;
  } catch {
    loaded = {};
  }
  cache = loaded;
  return cache;
}

/**
 * 存下来的密钥。解不开就当作没配。
 *
 * 解不开是有真实原因的：换了机器、清过 `.data`、`secret.key` 被删。
 * 这时候抛异常会让整个配置页打不开，而人最需要的恰恰是打开它重填一次。
 */
export function getSavedApiKey(): { value?: string; state: "none" | "ok" | "undecryptable" } {
  const enc = getSavedModelConfig().apiKeyEnc;
  if (!enc) return { state: "none" };
  try {
    return { value: decryptSecret(enc), state: "ok" };
  } catch {
    return { state: "undecryptable" };
  }
}

/**
 * 写盘。`apiKey` 的三态：
 * - `undefined` 不动它
 * - `""` 清除落盘的密钥，回落到 env
 * - 非空 加密写入
 */
export function saveModelConfig(
  patch: Partial<Omit<SavedModelConfig, "apiKeyEnc" | "updatedAt">> & { apiKey?: string },
): SavedModelConfig {
  const cur = getSavedModelConfig();
  const next: SavedModelConfig = { ...cur };
  for (const k of ["baseUrl", "modelName", "think", "thinkBudget", "timeoutMs", "useQwenVL"] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    // 空串 / 空值 = 清掉这一项，回落到 env。绝不写空串占位。
    if (v === "" || v === null) delete next[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === "") delete next.apiKeyEnc;
    else next.apiKeyEnc = encryptSecret(patch.apiKey);
  }
  next.updatedAt = new Date().toISOString();
  // 这里**不吞异常**：见文件头第 ③ 条。
  writeFileSync(PATH, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

/** 只回元数据。值永不出服务端——照密钥库 `listSecretMeta` 的口径。 */
export function describeModelConfig(): {
  saved: Omit<SavedModelConfig, "apiKeyEnc">;
  apiKey: { set: boolean; state: "none" | "ok" | "undecryptable" };
} {
  const { apiKeyEnc, ...rest } = getSavedModelConfig();
  const k = getSavedApiKey();
  return { saved: rest, apiKey: { set: k.state === "ok", state: k.state } };
}

/** 测试用：把内存缓存丢掉，下一次读重新读盘。 */
export function _resetModelConfigCache(): void {
  cache = null;
}
