import "dotenv/config";
import { getSavedApiKey, getSavedModelConfig } from "./modelconfig.js";

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * 四段回落：`override → 落盘 → env → 默认`。
 *
 * 中间那一层（落盘）此前**不存在**——界面上填的东西没有任何去处，
 * 而同一个文件里 chain 配置早就有这一层（`chainOverride` / `setChainConfig`）。
 *
 * 空串一律视为「没配，继续下落」。这不是洁癖：运行侧用的是 `??`，
 * 空串在那边是**有效值**并就地停住，于是 `.env` 里一行空的 `OPENAI_API_KEY=`
 * 会让探活回落到 `MIDSCENE_MODEL_API_KEY` 拿到真 key 报绿，
 * 而运行发出 `Bearer `（空）拿 401——**探活绿、运行 401，而 401 读起来像模型服务坏了**。
 * 统一到「空串 = 没配」之后这条谎消失。
 */
const pick = (...xs: Array<string | undefined>): string => xs.find((x) => x && x.trim()) ?? "";

export function resolveModelConfig(override?: Partial<ModelConfig>): ModelConfig {
  const saved = getSavedModelConfig();
  const key = getSavedApiKey();
  return {
    baseUrl: pick(
      override?.baseUrl,
      saved.baseUrl,
      process.env.OPENAI_BASE_URL,
      process.env.MIDSCENE_MODEL_BASE_URL,
      "http://127.0.0.1:8000/v1", // the model itself; the no-think proxy (:8010) is optional
    ),
    apiKey: pick(
      override?.apiKey,
      key.state === "ok" ? key.value : undefined,
      process.env.OPENAI_API_KEY,
      process.env.MIDSCENE_MODEL_API_KEY,
      "1234",
    ),
    modelName: pick(override?.modelName, saved.modelName, process.env.MIDSCENE_MODEL_NAME, "Qwen3.8-27B-4bit"),
  };
}

/** 这一项到底来自哪儿。界面要说得出「你改了 .env 为什么没反应」。 */
export type FieldSource = "saved" | "env" | "default";

/**
 * 运行参数全集，外加每一项的来源。
 *
 * 「来源」不是装饰：落盘优先于 env，所以「我改了 .env 怎么没反应」是这次改造
 * **必然会制造**的一类困惑。唯一的解法是把它说出来，而不是让人去猜优先级。
 */
export function resolveModelRuntime(override?: Partial<ModelConfig>): ModelConfig & {
  noThink: boolean;
  thinkBudget?: number;
  timeoutMs?: number;
  useQwenVL: boolean;
  sources: Record<"baseUrl" | "apiKey" | "modelName" | "think", FieldSource>;
} {
  const saved = getSavedModelConfig();
  const key = getSavedApiKey();
  const cfg = resolveModelConfig(override);
  const src = (savedHas: boolean, envHas: boolean): FieldSource =>
    savedHas ? "saved" : envHas ? "env" : "default";
  return {
    ...cfg,
    // 落盘里 `think: false` 表示关思考。没配就沿用今天的 env 语义：TP_MODEL_THINK=0 才关。
    noThink: saved.think !== undefined ? !saved.think : process.env.TP_MODEL_THINK === "0",
    thinkBudget: saved.thinkBudget ?? (process.env.TP_MODEL_THINK_BUDGET ? Number(process.env.TP_MODEL_THINK_BUDGET) : undefined),
    timeoutMs: saved.timeoutMs ?? (process.env.TP_MODEL_TIMEOUT_MS ? Number(process.env.TP_MODEL_TIMEOUT_MS) : undefined),
    useQwenVL: saved.useQwenVL ?? process.env.MIDSCENE_USE_QWEN3_VL === "1",
    sources: {
      baseUrl: src(!!saved.baseUrl, !!(process.env.OPENAI_BASE_URL || process.env.MIDSCENE_MODEL_BASE_URL)),
      apiKey: src(key.state === "ok", !!(process.env.OPENAI_API_KEY || process.env.MIDSCENE_MODEL_API_KEY)),
      modelName: src(!!saved.modelName, !!process.env.MIDSCENE_MODEL_NAME),
      think: src(saved.think !== undefined, process.env.TP_MODEL_THINK !== undefined),
    },
  };
}

/**
 * 把生效值写回 `process.env`。
 *
 * 这是让配置传导到**子进程**的唯一通道，也是让 harness-core 零改动的关键：
 * `modelFromEnv()` 与三个进程的 env 都读 `process.env`，而 supervisor spawn 时
 * 传的是 `{...process.env, ...spec.env}`。在这里写一次，
 * 此后任何 import 顺序下它们读到的都是落盘值——**不必维护第二条解析路**。
 *
 * 注意：agent / runner 是在 spawn 那一刻拿到快照的，所以改了配置要它们生效
 * 仍然需要重启子进程。这一点必须在界面上说出来，不能让人以为保存即全局生效。
 */
/**
 * 进程启动那一刻的 env，**在任何一次 `applyModelEnv` 之前**拍下来。
 *
 * 没有它，「清除落盘、回到 env」这个动作是做不到的：`applyModelEnv` 把落盘值写进了
 * `process.env`，清掉落盘之后那个值还留在 env 里，界面会显示「来源：env」——
 * 一个刚被清掉的值，被报告成「这是你环境变量里配的」。
 * 那正是这次改造要消灭的那类谎，只是换了个方向。
 */
const ENV0: Record<string, string | undefined> = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  MIDSCENE_MODEL_BASE_URL: process.env.MIDSCENE_MODEL_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  MIDSCENE_MODEL_API_KEY: process.env.MIDSCENE_MODEL_API_KEY,
  MIDSCENE_MODEL_NAME: process.env.MIDSCENE_MODEL_NAME,
  TP_MODEL_THINK: process.env.TP_MODEL_THINK,
  TP_MODEL_THINK_BUDGET: process.env.TP_MODEL_THINK_BUDGET,
  TP_MODEL_TIMEOUT_MS: process.env.TP_MODEL_TIMEOUT_MS,
  MIDSCENE_USE_QWEN3_VL: process.env.MIDSCENE_USE_QWEN3_VL,
};

/** 原始 env 里这一项是什么。落盘没配这一项时要还原成它。 */
function restoreEnv(): void {
  for (const [k, v] of Object.entries(ENV0)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export function applyModelEnv(): void {
  // 先还原，再覆盖。否则清掉落盘之后旧值会永远留在 env 里。
  restoreEnv();
  const saved = getSavedModelConfig();
  const key = getSavedApiKey();
  /**
   * **只写真正配过的那几项，不写兜底的默认值。**
   *
   * 把 `apiKey` 的兜底 `"1234"` 也写回去，等于在「一个密钥都没配」的时候
   * 假装配过了——运行侧此前发的是空的 `Bearer `，那至少还能从 401 里看出来；
   * 写成 `1234` 之后它变成一个看起来正常、实则永远认证失败的值。
   * 掩盖「你没配」比暴露它糟得多。
   *
   * 同理，落盘里没有的项一律不动 env：这就是「不配置就原样回落今天的行为」的实现。
   */
  if (saved.baseUrl) {
    process.env.OPENAI_BASE_URL = saved.baseUrl;
    process.env.MIDSCENE_MODEL_BASE_URL = saved.baseUrl;
  }
  if (key.state === "ok" && key.value) {
    process.env.OPENAI_API_KEY = key.value;
    process.env.MIDSCENE_MODEL_API_KEY = key.value;
  }
  if (saved.modelName) process.env.MIDSCENE_MODEL_NAME = saved.modelName;
  if (saved.think !== undefined) process.env.TP_MODEL_THINK = saved.think ? "1" : "0";
  if (saved.thinkBudget !== undefined) process.env.TP_MODEL_THINK_BUDGET = String(saved.thinkBudget);
  if (saved.timeoutMs !== undefined) process.env.TP_MODEL_TIMEOUT_MS = String(saved.timeoutMs);
  if (saved.useQwenVL !== undefined) process.env.MIDSCENE_USE_QWEN3_VL = saved.useQwenVL ? "1" : "0";
}

// N-03: no import-time environment mutation. New runs use explicit role snapshots.
// applyModelEnv remains a legacy utility, never called by production routes.

export const PORT = Number(process.env.PORT) || 5301;

// Screenshot viewport (= the image size sent to the vision model). Midscene resizes
// each screenshot down to the logical viewport before the model call, so shrinking the
// viewport is the agent-layer lever for prompt size. Memory-constrained self-hosted VL
// models (e.g. MLX on Apple Silicon) reject large prompts ("prefill memory guard") on
// content-rich pages; a smaller viewport keeps them under the limit. Tunable via env.
export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}
export function resolveViewport(): Viewport {
  return {
    width: Number(process.env.MIDSCENE_SHOT_WIDTH) || 1024,
    height: Number(process.env.MIDSCENE_SHOT_HEIGHT) || 720,
    // Force DSF=1: on a retina host the shot would otherwise be captured at 2x before
    // Midscene downsizes it — wasted work that doesn't shrink the model image.
    deviceScaleFactor: Number(process.env.MIDSCENE_SHOT_DSF) || 1,
  };
}

// Chain the injected wallet provider talks to (a local Anvil fork by default, but any RPC —
// a Tenderly Virtual TestNet public RPC, a public testnet, etc.). Configurable via env and
// overridable per request.
export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
}

// Runtime override (settable from the UI via POST /api/config), layered over env + defaults.
let chainOverride: Partial<ChainConfig> = {};

export function setChainConfig(patch: Partial<ChainConfig>): ChainConfig {
  chainOverride = {
    ...chainOverride,
    ...(patch.rpcUrl !== undefined ? { rpcUrl: patch.rpcUrl } : {}),
    ...(patch.chainId !== undefined ? { chainId: patch.chainId } : {}),
  };
  return resolveChainConfig();
}

export function resolveChainConfig(override?: Partial<ChainConfig>): ChainConfig {
  return {
    rpcUrl:
      override?.rpcUrl ||
      chainOverride.rpcUrl ||
      process.env.CHAIN_RPC_URL ||
      "http://127.0.0.1:8545",
    chainId:
      override?.chainId ??
      chainOverride.chainId ??
      Number(process.env.CHAIN_ID || 1),
  };
}

/**
 * 探针图：16×16 纯红 PNG。
 *
 * 原先是 1×1。托管网关会**直接拒收**这么小的图（"too large, corrupted, or an unsupported
 * format"），于是自检把一个能看图的模型报成 `notMultimodal` —— 一个假阴性，而它的后果是
 * 让人以为执行链路用不了。探针要小到不花钱，也要真到不被当成坏文件。
 */
export const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
