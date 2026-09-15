import { homedir } from "node:os";
import { join } from "node:path";
import { defineHarnessConfig } from "@testpilot/harness-core";

/** 本机基准应用放在哪。不设就是 `~/bench`；仓库里不写死任何人的主目录。 */
const benchDir = process.env.TP_BENCH_DIR ?? join(homedir(), "bench");

/**
 * The knobs, in one place. Environment variables still override everything here
 * (MODEL_CONCURRENCY, RUN_CONCURRENCY, RUNNER_COUNT, EVENTS_KEEP, ABLATE, DENY_HOSTS…),
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
     * 「这个被测对象允许做不可逆的事」是**环境的属性**，由人在环境设置里勾选（`allowIrreversible`），跟着项目走。
     *
     * 这里只有一张**禁止名单**：绝不能碰的地址，环境怎么勾都不放行。主网 `app.hyperliquid.xyz` 在上面——
     * 同一个钱包在那边有真钱（2026-09-12 实测 Portfolio Value $6.77），同一串点击就是在花钱，
     * 而它和测试网只差一个域名。这是运营方的安全配置，不是领域逻辑。
     */
    denyHosts: ["app.hyperliquid.xyz"],
    // Irreversible-looking steps (delete / pay / transfer …) are refused unless the environment allows
    // them. This is the "someone ran the whole suite against production" guard, not a security boundary.
    blockIrreversible: true,
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
      id: "bench-juiceshop",
      kind: "app",
      description:
        "OWASP Juice Shop（Angular SPA）：登录、注册、搜索、购物篮、结账、带校验的投诉表单。" +
        "不在那套公开基准里，所以没有可对照的基线——它补的是**界面形态的覆盖面**",
      // 不走 docker：Docker Hub 的 blob CDN 在这台机器上反复超时（四次都在最后几层断），
      // 而 GitHub 发行版通、本机 node 正好是 v22.17.0 arm64、发行版正好有
      // node22_darwin_arm64——原生直跑，还省掉一层 amd64 模拟。md5 校验过。
      command: "node",
      args: ["build/app.js"],
      cwd: join(benchDir, "juice-shop_20.2.0"),
      env: { PORT: "8084" },
      autostart: false,
      healthcheck: { kind: "http", url: "http://localhost:8084/" },
    },
    {
      id: "bench-dimeshift",
      kind: "app",
      description:
        "DimeShift（Backbone 单页应用，真实路由）：钱包、收支、目标、注册登录。" +
        "**在公开 AWGT 研究的主题应用集里**，而且不登录就能用——它是第三个基准，也是唯一" +
        "一个探索改进没对着它调过的，所以泛化只能由它来回答",
      command: "docker",
      // 按 digest 钉死。tag 是 `non-empty-db`（带种子数据），但 digest 比 tag 更稳。
      // 这个镜像的 Cmd 是 bash（当虚拟机用），服务要自己起——启动命令是从镜像里的
      // /root/.bash_history 翻出来的，脚本先起 MySQL 再 npm start。
      args: [
        "run",
        "--name",
        "tp-bench-dimeshift",
        "-p",
        "8085:8080",
        "dockercontainervm/dimeshift@sha256:0316bd172d772820c66b705b1c5aa706019e5eab941a4a9161d3e323e322af1f",
        "bash",
        "-c",
        "cd /home/dimeshift-application && ./run-services-docker.sh",
      ],
      autostart: false,
      healthcheck: { kind: "http", url: "http://localhost:8085/" },
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
      env: { MODEL_UPSTREAM: process.env.MODEL_UPSTREAM ?? "https://tokenharbor.ai", PROXY_PORT: "8010" },
      // Autostarted: Midscene exposes no per-request body hook, so this is the only place
      // `enable_thinking:false` can be injected into ITS calls — and without it a Qwen3.x
      // model answers with its own reasoning instead of the expected output.
      /**
       * **不再自启动。**
       *
       * 它的存在理由是「Midscene 没有逐请求改 body 的钩子，所以要在代理里关掉思考」。
       * 而现在**默认就是开思考**（见 `modelFromEnv`，那个默认值是量出来的）——
       * 一个专门用来关思考的代理，自启动就是反的。
       *
       * 它还反复造成实际损害：上游指着已欠费的出口、端口被占时进入崩溃重启循环、
       * 把事件缓冲刷满（一次实测 600 条事件里 457 条是它的崩溃日志，探索的日志全被挤掉）。
       * 需要它的时候（要抓 LLM 调试、或者上游必须关思考）再手动起。
       */
      autostart: false,
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
