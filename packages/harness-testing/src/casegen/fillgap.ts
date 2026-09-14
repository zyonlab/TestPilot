import { z } from "zod";
import type { ModelClient } from "@testpilot/harness-core";
import { CASES_SCHEMA, CASES_STABLE, languageDirective } from "./prompts.js";
import { parseJson } from "./nodes.js";
import { TextCaseSchema, type TextCase } from "./types.js";

/**
 * 把一条缺口补成一条用例。
 *
 * 缺口分析能把缺口分成三类、算得出、显示得出——**然后停在那里**。没有任何一条代码路径
 * 把一条缺口变回一条用例，而「这套 harness 会把自己漏掉的东西补回来」这句话，
 * 缺的正是这一段。
 *
 * 三类缺口要的不是同一种用例，这一点写进提示词里，而不是留给模型猜：
 * - `missed`：走到过、但没有用例验它。**证据是有的**——那条转移的动作和落点都在，
 *   所以补出来的用例应该沿着那条路走，判据落在落点上。
 * - `unseen`：看见过入口、但从来没进去。补出来的用例是**去把它打开**，
 *   而不是假装知道里面长什么样——后者会写出一条对着幻觉的断言。
 * - `blind`：连看都没看见（比如登录挡住了）。这一类**不该硬补**：
 *   一条对着没人见过的界面写出来的用例，它的绿色说明不了任何事。
 *
 * 补出来的东西进复核队列，不进看板——它和别的候选一样，等的是同一个决定。
 */

const FILLGAP_STABLE = [
  CASES_STABLE,
  "",
  "GAP MODE: you are given ONE gap the harness found in its own coverage, and you write",
  "ONE case that closes it.",
  "- A `missed` gap has evidence: the transition was walked, its action and destination are",
  "  given. Follow that path and assert on what the destination shows.",
  "- An `unseen` gap means the entrance was seen but never opened. The case's job is to",
  "  OPEN it. Do not assert on what is behind the door — nobody has looked. Assert that the",
  "  door opened: the address changed, or a heading appeared.",
  "- Never invent a literal (an id, a name, a price) that is not in the evidence given.",
  "  A case that asserts on a made-up value does not fail honestly.",
  "- Return exactly one case.",
].join("\n");

export interface FillGapInput {
  gap: {
    kind: string;
    reach: "missed" | "unseen" | "blind";
    what: string;
    detail?: string;
    anchor?: { kind: "edge"; from: string; to: string } | { kind: "state"; id: string };
  };
  /** 这条缺口归到哪个模块/故事下——补出来的用例得挂在同一处，否则故事地图上多一根断线。 */
  storyId?: string;
  /** 状态流图里那一处附近的样子：路由、标题、看得见的控件。证据，不是猜测。 */
  evidence?: string[];
  specText?: string;
  lang?: string;
}

export interface FillGapResult {
  kase: TextCase;
  tokens: number;
  ms: number;
}

function variable(input: FillGapInput): string {
  const { gap, evidence, specText } = input;
  const lines: string[] = [
    `THE GAP (${gap.reach} · ${gap.kind}):`,
    gap.what,
    ...(gap.detail ? [`evidence: ${gap.detail}`] : []),
    ...(gap.anchor
      ? [
          gap.anchor.kind === "edge"
            ? `it sits on the transition ${gap.anchor.from} → ${gap.anchor.to}`
            : `it sits on the state ${gap.anchor.id}`,
        ]
      : []),
  ];
  if (evidence?.length) lines.push("", "WHAT THE EXPLORER SAW AROUND IT:", ...evidence);
  if (specText) lines.push("", "SPECIFICATION (for wording and vocabulary):", specText.slice(0, 4000));
  lines.push("", languageDirective(input.lang));
  return lines.join("\n");
}

export async function fillGap(model: ModelClient, input: FillGapInput): Promise<FillGapResult> {
  /*
   * `blind` 不补。
   *
   * 一条对着没人见过的界面写出来的用例，它的绿色说明不了任何事——而它会**看起来**
   * 像覆盖率涨了一格。把这一类挡在这里而不是留给模型判断，是因为模型被要求写一条用例时
   * 总能写出一条来。
   */
  if (input.gap.reach === "blind")
    throw new Error(
      `这条缺口是「连看都没看见」（${input.gap.what}）——补一条对着没人见过的界面写的用例，` +
        `它的绿色说明不了任何事。先让探索能进去，再补。`,
    );

  const res = await model.chat({
    stable: FILLGAP_STABLE,
    variable: variable(input),
    schema: CASES_SCHEMA,
    maxTokens: 1200,
    label: `fillgap:${input.gap.kind}`,
  });
  /*
   * `key` 由这里派生，不让模型给。
   *
   * 它是去重用的那把键，而一个模型编出来的 key 会让同一条缺口补两次得到两条
   * 互不认识的用例——去重的意义正好被它绕开。
   */
  const shape = z.object({
    cases: z.array(TextCaseSchema.omit({ id: true, storyId: true, key: true })).min(1),
  });
  const parsed = parseJson(res.text, shape, "fillgap", { truncated: res.truncated, maxTokens: 1200 });
  return {
    kase: {
      ...parsed.cases[0],
      // id 带上出处：这条用例是**补出来的**，两个月后要能看出它不是原生那一批里的。
      id: `GAP-${Math.abs(hash(input.gap.what)).toString(36)}`,
      storyId: input.storyId ?? "",
      // 同一条缺口补两次是同一条用例，不是两条。
      key: `gap|${input.gap.reach}|${input.gap.what}`,
      /*
       * 它覆盖的就是那条缺口指着的转移。
       *
       * 不填这一格，补回来的用例在结构覆盖率上仍然是零——那正是它被补出来要解决的问题，
       * 于是「补了一条」和「没补」在数字上一模一样。
       */
      ...(input.gap.anchor?.kind === "edge"
        ? { covers: [`${input.gap.anchor.from}->${input.gap.anchor.to}`] }
        : {}),
    },
    tokens: res.tokens,
    ms: res.ms,
  };
}

/** 一个稳定的短哈希，只用来给补出来的用例一个不会撞的 id。 */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
