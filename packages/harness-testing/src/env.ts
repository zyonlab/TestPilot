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
export function resolveViewport(): Viewport {
  return {
    width: Number(process.env.MIDSCENE_SHOT_WIDTH) || 1024,
    height: Number(process.env.MIDSCENE_SHOT_HEIGHT) || 720,
    // Force DSF=1: on a retina host the shot would otherwise be captured at 2x before
    // Midscene downsizes it — wasted work that doesn't shrink the model image.
    deviceScaleFactor: Number(process.env.MIDSCENE_SHOT_DSF) || 1,
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
