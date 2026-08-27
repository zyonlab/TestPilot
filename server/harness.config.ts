import { defineHarnessConfig } from "@testpilot/harness-core";

/**
 * The knobs, in one place. Environment variables still override everything here
 * (MODEL_CONCURRENCY, RUN_CONCURRENCY, RUNNER_COUNT, EVENTS_KEEP, ABLATE, ALLOW_HOSTS…),
 * so this file is the map of what exists rather than a lock on the values.
 */
export default defineHarnessConfig({
  /**
   * 准入并发。
   *
   * 自托管那颗一次只服务一个请求、并发就 502，所以一直是 1。换到托管接口之后这个理由
   * 不成立了——限制变成了**限流**（免费档 20 次/分钟），而不是「它会崩」。3 够用且留了余量：
   * G1 那十几次串行文本调用是这条流水线最长的一段，摊开就是几分钟对半小时的差别。
   * 切回本地时记得改回 1。
   */
  model: { concurrency: 3 },
  execution: { queueConcurrency: 1, runnerCount: 1 },
  events: { keepLast: 200_000, trimMs: 10 * 60_000 },
  budget: { calls: 500, usd: 0, ms: 4 * 60 * 60_000 },
  ablate: [],
  guard: {
    /**
     * 基准应用全部跑在本机，所以白名单回到只有 localhost。
     *
     * `www.saucedemo.com` 曾经在这里——那时它是基准，而基准的重头是结账，
     * 「checkout / pay」正是 `blockIrreversible` 在白名单外要拦的东西。
     * 2026-08-27 撤下它之后这条豁免也就没有理由了：**一条没有理由的白名单条目，
     * 下一次有人对着生产环境跑套件时会替他放行。**
     */
    allowHosts: ["localhost", "127.0.0.1", "::1"],
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
    /**
     * 基准应用。
     *
     * 它们是**被测对象**，不是 harness 的一部分——但形态和其它能力完全一样：一个声明式的
     * 外部服务、一个健康探针、由监工托管、在进程页起停。放进这里而不是写进 README，
     * 是因为「怎么起这个基准」必须和「用它跑出来的数字」放在同一个可版本化的地方。
     *
     * `autostart: false`：它们要拉镜像、占内存，不该跟着网关一起起来。
     * 版本全部 pin 死——`latest` 会在某天悄悄换掉被测对象，而那种变化在结果里
     * 看起来像 harness 变了。
     *
     * 只登记**已核实镜像存在**的那些。其余四个（retroboard / dimeshift / splittypie /
     * phoenix）见 `fixtures/benchmark/apps.json`：没有可公开拉取的镜像，写一条没核实过的
     * `docker run` 进来，等于给出一个跑不起来的承诺。
     */
    {
      id: "bench-petclinic",
      kind: "app",
      description:
        "Spring PetClinic（服务端渲染版）：增删改查、表单校验、搜索、分页、跨实体关联。" +
        "单容器自带界面，是这套基准里第一个要跑通的",
      command: "docker",
      /**
       * **不带 `--rm`。**
       *
       * 实测：第一次用 `--rm` 起的 PetClinic 中途退出了，容器连同日志一起被删掉——
       * 下一次运行报 `ERR_CONNECTION_REFUSED`，而为什么退出的证据已经没了。
       * 基准容器死的时候正是最需要日志的时候；留着它，`docker logs` 还能回答问题。
       * 代价是要手动清理，那个代价比丢证据小得多。
       */
      args: ["run", "--name", "tp-bench-petclinic", "-p", "8080:8080", "springcommunity/spring-framework-petclinic:6.1.2"],
      autostart: false,
      healthcheck: { kind: "http", url: "http://localhost:8080/" },
    },
    {
      id: "bench-pagekit",
      kind: "app",
      description: "Pagekit（Vue + PHP）：后台管理、内容编辑、权限。sqlite 变体免去外部数据库",
      command: "docker",
      args: ["run", "--name", "tp-bench-pagekit", "-p", "8082:80", "pagekit/pagekit:sqlite"],
      autostart: false,
      healthcheck: { kind: "http", url: "http://localhost:8082/" },
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
      // 代理用 fetch 转发并原样带上 Authorization，所以 https 上游可直接指。
      // 切回本地：改成 http://127.0.0.1:8000。
      env: { MODEL_UPSTREAM: "https://tokenharbor.ai", PROXY_PORT: "8010" },
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
