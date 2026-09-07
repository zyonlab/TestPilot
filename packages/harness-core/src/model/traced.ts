import { beginObservation, isTracingEnabled } from "../obs/langfuse.js";
import { requestKey, type ChatRequest, type ChatResponse, type ModelClient } from "./client.js";

/**
 * 给任何 `ModelClient` 包一层追踪，产出一条 Langfuse `generation`。
 *
 * 放在这一层而不是放进 `OpenAIModel`，理由和 `gated()` 一样：包住接口就一次包住了所有实现，
 * 包住某个实现，`RecordedModel` 和以后换的实现就漏在外面。所有节点、修复循环、评测判官、
 * 复核重写、critic 都从 `ModelClient` 过。
 *
 * **但它不是这个系统唯一的模型出口，这一点必须写清楚，否则读 trace 的人会以为看到了全部。**
 * 另外两条通道不经过这里：
 *
 *   `server/src/model.ts`   网关手写的 `chat()`（探活 / 生成代码 / 改写用例）。
 *                           它有自己一套默认值，换成 `OpenAIModel` 会一起改掉那三处的行为，
 *                           所以暂时保留，但已在那一侧手工开了 `generation`。
 *   Midscene 的 `ai*` 调用   驱动浏览器的那些（`aiAction` / `aiAssert`）。它们只过准入闸
 *                           （`withModel`），token 要靠事后扒 Midscene 的日志文件才拿得到
 *                           （见 `harness-testing/src/report.ts`）。**这部分目前不在 trace 上。**
 *
 * 后果是可预期的：**按 `ModelClient` 的调用数去估并发或成本，会低估真实负载。**
 *
 * 组合顺序是有意义的：`traced(gated(client))` 与 `gated(traced(client))` 量的是两件事。
 *
 *   `gated(traced(x))`  span 只覆盖真正的 HTTP 往返
 *   `traced(gated(x))`  span 还包含**排队等准入槽位的时间**
 *
 * 用后者。这条流水线上单模型并发是 1–3，而 G1 那十几次串行调用最长的一段恰恰是排队——
 * 一个把等待时间藏起来的延迟数字，会让人去优化模型而不是去优化并发。
 */
export function traced(client: ModelClient, opts: { name?: string } = {}): ModelClient {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      if (!isTracingEnabled()) return client.chat(req);

      /**
       * 观测的名字用 `label` 的**类型部分**，不用它的全文。
       *
       * `design.cases:S-03` 这种 label 带着实例 id，而观测名要低基数——名字是拿来筛选、
       * 建看板、挂 LLM-as-judge 的，每次运行都产生新名字就等于这三样都用不了。
       * 实例 id 进 metadata，那里它不影响聚合。
       */
      const label = req.label ?? opts.name ?? "model.chat";
      const name = label.split(":")[0];
      const instance = label.includes(":") ? label.slice(label.indexOf(":") + 1) : undefined;

      const gen = beginObservation(
        name,
        {
          /**
           * 输入按 OpenAI 的消息格式给，因为 Langfuse 按这个形状把它渲染成对话；
           * 给一个自定义 JSON 会显示成一坨原始文本。这正好也是这个客户端真实发出去的形状：
           * stable 进 system，variable 进 user（见 `openai.ts`）。
           */
          input: [
            { role: "system", content: req.stable },
            {
              role: "user",
              content: req.images?.length
                ? [
                    { type: "text", text: req.variable },
                    // 图片本身不发给 Langfuse：一张截图是几 MB 的 data URI，
                    // 而对读 trace 的人有意义的只是「这次带了几张图」。
                    ...req.images.map(() => ({ type: "image_url", image_url: { url: "[screenshot omitted]" } })),
                  ]
                : req.variable,
            },
          ],
          modelParameters: {
            ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
            // 这条流水线全程 temperature=0，写出来是因为「为什么两次结果不一样」
            // 是读 trace 的人最常问的第一个问题，而答案往往不是温度。
            temperature: 0,
          },
          metadata: {
            label,
            ...(instance ? { instance } : {}),
            /**
             * 请求指纹。它是 `RecordedModel` 用来命中录像的那把钥匙，
             * 也就是说：**两条 trace 上指纹相同，发出去的就是同一个请求**。
             * 对照两次运行为什么产出不同，这是第一个要看的东西。
             */
            requestKey: requestKey(req),
            hasSchema: Boolean(req.schema),
            images: req.images?.length ?? 0,
            promptChars: { stable: req.stable.length, variable: req.variable.length },
          },
        },
        "generation",
      );

      try {
        const res = await client.chat(req);
        gen.update({
          output: res.text,
          ...(res.model ? { model: res.model } : {}),
          /**
           * 用量。**录像回放不报用量。**
           *
           * 回放没有真的调模型，把录像里存的 token 数再报一遍，Langfuse 会按它算一次钱——
           * 于是跑一遍测试套件就会在成本看板上凭空多出一笔。这一类假数字最难发现，
           * 因为它看起来完全合理。
           */
          ...(res.replayed || !res.usage
            ? {}
            : {
                usageDetails: {
                  ...(res.usage.input !== undefined ? { input: res.usage.input } : {}),
                  ...(res.usage.output !== undefined ? { output: res.usage.output } : {}),
                  ...(res.usage.cached !== undefined ? { cache_read_input_tokens: res.usage.cached } : {}),
                  ...(res.usage.total !== undefined ? { total: res.usage.total } : {}),
                },
              }),
          metadata: {
            ms: res.ms,
            replayed: Boolean(res.replayed),
            /**
             * **被截断要显式报出来。**
             *
             * 截断的产出从外面看只是「短了一点」——规格少几条规则、用例从 40 条变成 9 条。
             * 这个仓库一天之内在这上面撞过四次（见 `openai.ts` 的 `chat` 注释）。
             * 在 trace 上它必须是一个可以筛的布尔值，而不是要靠读输出才能发现的事。
             */
            truncated: Boolean(res.truncated),
            outputChars: res.text.length,
          },
        });
        return res;
      } catch (e) {
        // 失败的调用也要留在 trace 上，而且要标成 ERROR：一次超时、一次 404、
        // 一次 guided decoding 被拒——这三种在报告里长得一样，在这里必须分得开。
        gen.update({
          level: "ERROR",
          statusMessage: (e as Error).message.slice(0, 500),
        });
        throw e;
      } finally {
        gen.end();
      }
    },
  };
}
