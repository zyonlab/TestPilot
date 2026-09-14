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
import { input, answer, abstain, config, deny, loadRepo, writeFileArgs } from "./lib/tp.mjs";
import { idsFromIndex, retrievedIdsFromTrace } from "./lib/provenance.mjs";

const NAME = "cases.json";

try {
  const msg = await input();
  const args = writeFileArgs(msg);
  if (!args) abstain();
  if (!/[/\\]runs[/\\][^/\\]+[/\\]cases\.json$/.test(args.file_path)) abstain();

  const runDir = path.dirname(args.file_path);
  const cfg = config();
  const { validate, fence } = await loadRepo();
  // 出处的两个基底从这次运行的 trace 与材料索引读（`lib/provenance.mjs`）；判决在共享的 validate.ts 里，
  // 和 MCP 的 write_cases 同一份——两份实现各自演化的教训见 00-架构.md §12。
  let basis;
  if (cfg.requireProvenance !== false) {
    const workspace = path.dirname(path.dirname(runDir));
    const traced = retrievedIdsFromTrace(msg.trace_path, (t) => fence.SPEC_FENCE.unwrap(t));
    basis = { retrieved: traced.ids, retrieveCalls: traced.calls, indexed: idsFromIndex(workspace) };
  }
  const v = validate.validateCases(args.content, basis);
  if (!v.ok) deny(runDir, "validate-cases", v.gate, v.reason, v.output);
  // 孤儿在这里就能看出来，但**不拦**：它是门禁①的一条 finding（`traceability`），由 gate1 打分。
  answer({ output: v.output, reason: v.reason });
} catch (err) {
  process.stderr.write(`validate-cases 自身出错：${err?.stack ?? err}`);
  process.exit(1);
}
