#!/usr/bin/env node
/**
 * `cases.json` 的形状，外加**出处**。和 validate-stories 同一个做法、同一个位置。
 *
 * 形状这半边比故事那边更要紧一点：`CaseBundleSchema` 里 `steps` 是 `.min(1)`、`expected` 是
 * `.min(1)`、`tier` 只能是 1/2/3、`key` 必填。这些不是格式洁癖——
 * `prompts.ts` 里记着一次真事故：JSON schema 允许空 `steps`、zod 那边拒绝，
 * 结果**整个故事的产出一条不剩**，而错误信息要到解析时才出现，那时模型调用的钱已经付过了。
 * 在写盘之前拦住，模型还在场，还能改。
 *
 * 出处这半边是 2026-09-03 加的（借 commerce-agents 的 provenance gate）：每条用例的
 * `sourceRefs` 必须是**这次运行里 `retrieve_spec` 真正返回过的段 id**。三个来源，按可靠性排：
 *
 * 1. trace 里 `mcp__testpilot__retrieve_spec` 的输出——「本会话工具返回过的 id」，
 *    这是 provenance 的本义；
 * 2. `<workspace>/materials/.index/index.json`——材料层面「这个 id 存在」，比 1 弱：
 *    存在不等于取过；
 * 3. 两个都没有——没有可核对的基底。**倾向 deny**（hook 契约 §8：拿不准的时候拒），
 *    因为放行等于宣布「出处成立」，而那正是要防的假绿灯。
 *
 * 规则本身在 `harness-testing/src/casegen/provenance.ts`，A 臂 `design.cases` 节点用的是同一份。
 */
import path from "node:path";
import { input, answer, abstain, config, deny, loadRepo, writeFileArgs, zodBrief } from "./lib/tp.mjs";
import { idsFromIndex, retrievedIdsFromTrace } from "./lib/provenance.mjs";

const NAME = "cases.json";

try {
  const msg = await input();
  const args = writeFileArgs(msg);
  if (!args) abstain();
  if (!/[/\\]runs[/\\][^/\\]+[/\\]cases\.json$/.test(args.file_path)) abstain();

  const runDir = path.dirname(args.file_path);
  let parsed;
  try {
    parsed = JSON.parse(args.content);
  } catch (err) {
    deny(runDir, "validate-cases", "schema",
      `${NAME} 不是合法 JSON：${err.message}。重写一遍这个文件，只写 JSON，不要带 Markdown 代码围栏。`,
      { file: NAME, valid: false, kind: "json" });
  }

  const { types, provenance, fence } = await loadRepo();
  const result = types.CaseBundleSchema.safeParse(parsed);
  if (!result.success) {
    deny(runDir, "validate-cases", "schema",
      `${NAME} 不符合 CaseBundleSchema：${zodBrief(result.error)}。` +
        `形状见 skill testpilot-design 的 REFERENCE.md；改完再写一次。`,
      { file: NAME, valid: false, kind: "schema", issues: result.error.issues.length });
  }

  const b = result.data;
  // 孤儿在这里就能看出来，但**不拦**：它是门禁①的一条 finding（`traceability`），
  // 由 gate1 打分。校验管形状，门禁管质量，两件事不要混在一个 deny 里。

  /* ------------------------------------------------------------- 出处 */
  const cfg = config();
  if (cfg.requireProvenance !== false) {
    const workspace = path.dirname(path.dirname(runDir));
    const traced = retrievedIdsFromTrace(msg.trace_path, (t) => fence.SPEC_FENCE.unwrap(t));
    const indexed = idsFromIndex(workspace);

    // 基底：取过的段优先；一次都没取过就退到索引；索引也没有就没有基底。
    const known = traced.ids.size ? traced.ids : indexed ?? new Set();
    const basis = traced.ids.size ? "trace" : indexed ? "index" : "none";

    if (traced.calls === 0) {
      deny(runDir, "validate-cases", "grounding",
        `这次运行还没有调用过 retrieve_spec，${NAME} 里的用例没有任何一段材料可以作为出处。` +
          `顺序是先读再写：先用 retrieve_spec 取和每条故事相关的规格段，把返回的 chunk id 逐字写进每条用例的 sourceRefs，再写 ${NAME}。`,
        { file: NAME, valid: false, kind: "provenance", cases: b.cases.length });
    }

    const report = provenance.checkProvenance(b.cases, known);
    if (report.unreferenced.length || report.unknown.length || basis === "none") {
      const what = provenance.describeProvenance(report);
      const how =
        basis === "none"
          ? "本次没有任何可核对的段 id（trace 里 retrieve_spec 没有返回段，materials/.index 也没有）——先调 retrieve_spec。"
          : `sourceRefs 只能填 retrieve_spec 这次返回过的 chunk id（形如 docs/x.md#3），逐字抄；` +
            `没取到的段先用 retrieve_spec 的 chunkIds 参数取一遍再引用。`;
      deny(runDir, "validate-cases", "provenance", `${NAME} 的出处对不上：${what || "没有可核对的基底"}。${how}`, {
        file: NAME,
        valid: false,
        kind: "provenance",
        basis,
        known: report.known,
        unreferenced: report.unreferenced.length,
        unknown: report.unknown.length,
        cases: b.cases.length,
      });
    }

    answer({
      output: {
        file: NAME,
        valid: true,
        cases: b.cases.length,
        stories: b.stories.length,
        provenance: basis,
        anchored: report.anchored,
        known: report.known,
      },
      reason:
        `${NAME} 通过 CaseBundleSchema：${b.cases.length} 条用例 / ${b.stories.length} 条故事；` +
        `出处全部对上（基底 ${basis}，${report.known} 个已知段）`,
    });
    process.exit(0);
  }

  answer({
    output: { file: NAME, valid: true, cases: b.cases.length, stories: b.stories.length },
    reason: `${NAME} 通过 CaseBundleSchema：${b.cases.length} 条用例 / ${b.stories.length} 条故事`,
  });
} catch (err) {
  process.stderr.write(`validate-cases 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
