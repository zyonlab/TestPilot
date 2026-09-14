import type { ChainConfig, Viewport } from "./types.js";

/**
 * Env-derived execution config. These read `process.env` in whichever process the
 * executor runs in — the supervisor passes the gateway's environment down to the runner,
 * so a run behaves identically on either side of the process boundary.
 */

// Screenshot viewport (= the image size sent to the vision model). Midscene resizes each
// screenshot down to the logical viewport before the model call, so shrinking the viewport
// is the agent-layer lever for prompt size: memory-constrained self-hosted VL models reject
// large prompts ("prefill memory guard") on content-rich pages.
export function resolveViewport(override?: Partial<Viewport>): Viewport {
  /*
   * 视口跟着**被测对象**走。
   *
   * 1024×720 这个默认值是为压小视觉模型的图定的，而它对一部分真实界面撑不开：
   * Binance 期货在这个宽度下**下单面板整块不渲染**，探索器只看得到图表和订单簿——
   * 而它不会报错，它只是看不见半个产品。
   *
   * 但也不能就此把默认调大：图变大，每一次模型调用都跟着变贵，
   * 而大多数被测对象在 1024 下是完整的。所以这是**每个环境自己的一个字段**，
   * 不是一个全局环境变量——后者会让所有 SUT 一起付这个代价。
   * 不配就沿用今天的默认，一个字节的行为都不变。
   */
  return {
    width: override?.width || Number(process.env.MIDSCENE_SHOT_WIDTH) || 1024,
    height: override?.height || Number(process.env.MIDSCENE_SHOT_HEIGHT) || 720,
    // Force DSF=1: on a retina host the shot would otherwise be captured at 2x before
    // Midscene downsizes it — wasted work that doesn't shrink the model image.
    deviceScaleFactor: override?.deviceScaleFactor || Number(process.env.MIDSCENE_SHOT_DSF) || 1,
  };
}

export function resolveChainConfig(override?: Partial<ChainConfig>): ChainConfig {
  return {
    rpcUrl: override?.rpcUrl || process.env.CHAIN_RPC_URL || "http://127.0.0.1:8545",
    chainId: Number(override?.chainId ?? process.env.CHAIN_ID ?? 31337),
  };
}

/**
 * Where the MetaMask build, the onboarded profile and the generated test account live.
 * Resolved from the working directory (the runner is started with the gateway's cwd) so
 * the same files are found from either process; TP_WALLET_DIR overrides it.
 */
export function walletsDir(): string {
  return process.env.TP_WALLET_DIR || `${process.cwd()}/.wallets`;
}

/** Midscene writes its reports/caches under this directory. */
export function midsceneDir(): string {
  return process.env.MIDSCENE_RUN_DIR || `${process.cwd()}/midscene_run`;
}
