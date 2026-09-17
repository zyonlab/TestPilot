/**
 * 产物的**唯一**前端类型来源。
 *
 * 此前每个阅读器各自声明一遍：`StoriesDrawer` 一份 `Story`、`Review` 一份 `Story` 和一份
 * `ReviewItem`、`CasesBoard` 又一份。声明的时候只写自己想画的键，于是同一份接口数据
 * 在故事地图上画出了「用户 · 能进入按姓氏检索主人的页面」，在故事抽屉里一个字都没有——
 * 不是拿不到，是那份本地接口里根本没写 `role`。
 *
 * 所以这里的规矩是：**字段全量**，与 `server/src/review.ts` 的 DTO 一一对应；
 * 产物字段的渲染只许出现在 `src/lib/artifact/` 下。想少画几个字段是渲染组件的决定，
 * 不是类型的决定——类型少一个字段，下游就永远不知道它存在过。
 */
import type { ReactNode } from "react";

/** 机器判据。与 `packages/harness-testing/src/exec/oracle.ts` 的 `MachineOracleSchema` 同构。 */
export type MachineOracle =
  | { kind: "text"; value: string }
  | { kind: "noText"; value: string }
  | { kind: "url"; value: string }
  | { kind: "count"; value: string; op?: "eq" | "gte" | "lte"; n: number }
  | { kind: "delta"; value: string; direction: "increased" | "decreased" | "unchanged"; by?: number }
  /** 生成内容的判据：模型按几句是/否条件判 samples 次，至少 minPass 次全部成立才过（tier 3）。 */
  | { kind: "judge"; criteria: string[]; samples?: number; minPass?: number }
  | {
      /** 问接口而不是看屏幕。交易页的真值（持仓/挂单/余额）在接口里是精确的数。 */
      kind: "api";
      url: string;
      method?: "GET" | "POST";
      body?: string;
      headers?: Record<string, string>;
      path: string;
      op: "eq" | "neq" | "gte" | "lte" | "exists" | "absent" | "increased" | "decreased" | "unchanged";
      value?: string | number | boolean;
      by?: number;
      settleMs?: number;
    };

/**
 * 门禁的一条 finding。
 *
 * `rule` 是稳定的规则 id，永远英文，用作 i18n key 的后缀；`args` 是句子里要填的洞；
 * `field` 说这条在挑哪个字段的毛病，界面据此把光标送过去。
 * `message` 是**旧格式**：领域层此前把整句人话拼死了带过来，没有 key 也没法译。
 * 存量数据里只有它，所以留着兜底，但新规则不许再填。
 */
export interface ArtifactFinding {
  rule: string;
  severity: string;
  message?: string;
  args?: Record<string, string | number>;
  field?: CaseField;
}

export type CaseField = "title" | "steps" | "expected" | "precondition" | "designMethod" | "covers";

/** 一条用户故事。字段与 `ReviewStory`（server/src/review.ts:85）一一对应。 */
export interface ArtifactStory {
  id: string;
  title: string;
  acceptance: string[];
  /** 谁在用。没有它的条目不是用户故事，是界面事实——界面要说出来，不能留白。 */
  role?: string;
  /** 为了什么。它是判断这条故事值不值得测的唯一依据。 */
  benefit?: string;
  /** 属于哪个模块。故事地图的横轴。 */
  activity?: string;
  /** 兑现的是哪条流程。 */
  flowId?: string;
  /** 指回规格里的哪一条需求。 */
  requirementId?: string;
  /** 来自哪份材料。 */
  source?: string;
  /** 出处是定位出来的（located）还是模型自称的（claimed）——两者可信度不同。 */
  sourceBy?: "located" | "claimed";
}

/** 一条文本用例。字段与 `ReviewItem`（server/src/review.ts:38）一一对应。 */
export interface ArtifactCase {
  caseId: string;
  title: string;
  storyId: string;
  designMethod: string;
  tier: number;
  precondition: string[];
  steps: string[];
  expected: string;
  /** 判决真正由谁下。没有它的用例执行时要问模型。 */
  oracle?: MachineOracle;
  /** 走了哪些状态转移（`from->to`）。把用例挂回产品模型上的那根线。 */
  covers?: string[];
  /** 指回哪一条需求。 */
  requirementId?: string;
  /** 把产品放回去的动作。写操作的用例没有它，就会毒化它自己以后的每一次运行。 */
  postSteps?: string[];
  findings: ArtifactFinding[];
  code?: string;
  codeBlocked?: boolean;
  codeFindings?: ArtifactFinding[];
  degraded?: boolean;
  decision?: "approved" | "rejected";
  priority?: string;
}

export const TIER_KEY: Record<number, string> = {
  1: "artifact.tier1",
  2: "artifact.tier2",
  3: "artifact.tier3",
};

/** 设计方法的 i18n key。模型返回的是英文枚举，界面不该原样显示。 */
export const METHOD_KEY: Record<string, string> = {
  equivalence: "artifact.method.equivalence",
  boundary: "artifact.method.boundary",
  "state-transition": "artifact.method.stateTransition",
  "decision-table": "artifact.method.decisionTable",
  negative: "artifact.method.negative",
};

/** 一行「标签：值」。产物卡里所有的段落都长这样，所以它只写一次。 */
export interface FieldRow {
  label: string;
  body: ReactNode;
  /** 空值时说出来为什么空，而不是不渲染——不渲染等于宣称这个字段不存在。 */
  emptyNote?: string;
}
