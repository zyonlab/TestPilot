import { defineHarnessConfig } from "@testpilot/harness-core";

/**
 * The knobs, in one place. Environment variables still override everything here
 * (MODEL_CONCURRENCY, RUN_CONCURRENCY, RUNNER_COUNT, EVENTS_KEEP, ABLATE, ALLOW_HOSTS…),
 * so this file is the map of what exists rather than a lock on the values.
 */
export default defineHarnessConfig({
  // One self-hosted VL model: admission is 1, no matter how many browsers are open.
  model: { concurrency: 1 },
  execution: { queueConcurrency: 1, runnerCount: 1 },
  events: { keepLast: 200_000, trimMs: 10 * 60_000 },
  budget: { calls: 500, usd: 0, ms: 4 * 60 * 60_000 },
  ablate: [],
  guard: {
    // www.saucedemo.com is Sauce Labs' public E2E practice target: nothing on it is real
    // and "Reset App State" undoes everything. It has to be allowlisted because the whole
    // point of the benchmark is the checkout flow, and "checkout"/"pay" is exactly what
    // blockIrreversible refuses off the allowlist.
    allowHosts: ["localhost", "127.0.0.1", "::1", "www.saucedemo.com", "saucedemo.com"],
    // Irreversible-looking steps (delete / pay / transfer …) are refused outside the
    // allowlist. This is the "someone ran the whole suite against production" guard,
    // not a security boundary.
    blockIrreversible: true,
    allowlistOnly: false,
  },

  // External services the harness can start and supervise. Declarative on purpose: a
  // recipe is reproducible and auditable, an ad-hoc spawn is neither.
  capabilities: [
    {
      id: "anvil-local",
      kind: "chain",
      description: "Local Anvil devnet (chainId 31337) seeded with the test wallet",
      command: "anvil",
      args: [
        "--mnemonic-random", // replaced at start when .wallets/seed.txt exists
        "--chain-id",
        "31337",
        "--host",
        "127.0.0.1",
        "--port",
        "8545",
        "--silent",
      ],
      healthcheck: { kind: "rpc", url: "http://127.0.0.1:8545", method: "eth_chainId" },
    },
    {
      id: "model-proxy",
      kind: "model",
      description:
        "No-think proxy in front of the model at :8000. Midscene's calls are routed through " +
        "it (thinking mode makes a VL model answer with reasoning); it is also the single " +
        "capture point for LLM debug",
      command: "node",
      args: ["scripts/model-proxy.mjs"],
      env: { MODEL_UPSTREAM: "http://127.0.0.1:8000", PROXY_PORT: "8010" },
      // Autostarted: Midscene exposes no per-request body hook, so this is the only place
      // `enable_thinking:false` can be injected into ITS calls — and without it a Qwen3.x
      // model answers with its own reasoning instead of the expected output.
      autostart: true,
      healthcheck: {
        kind: "http",
        url: "http://127.0.0.1:8010/v1/models",
        // The key is referenced, not written down: a recipe is a config file, and config
        // files get committed. Resolved from the environment at registration time.
        headers: { Authorization: "Bearer ${env.OPENAI_API_KEY}" },
      },
    },
  ],
});
