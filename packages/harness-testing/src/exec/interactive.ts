import {settleOn} from './pageReady.js';
export {settleOn} from './pageReady.js';
// Interactive sessions: exploration and step-by-step debugging.
//
// Unlike a case run, these are *streamed* — the UI watches the page while the model
// thinks. They emit frames instead of returning one result, and screenshots leave as file
// refs: the frames also land in lineage, and lineage must not fill up with base64 JPEGs.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveText, redact, withModel, type ResolveContext } from "@testpilot/harness-core";
import { launchSession, type LaunchOpts, type Session } from "./session.js";
import { isInfraError } from "../failure.js";
import {
  abstractionOf,
  describeGraph,
  pathOf,
  type SfgState,
  type SfgTransition,
  type StateFlowGraph,
  abstractionNameOf,
} from "./sfg.js";
import { CharterTracker, describeReport, matchTarget, routeAllowed, type ExplorationCharter, type ExplorationReport } from "../domain/index.js";

/**
 * 做实验的三个等价类。
 *
 * 一个输入框的取值空间，对测试有意义的划分就这三块加一块「填对的」：
 * 空、格式不对、格式对但系统里查不到。遍历永远走不到后面两块——它们不在任何一条
 * 点击路径上，只有故意填进去才会出现。而两应用各五次的数据显示，**每次都漏的十条
 * 里有六条落在这两块里**。
 */
/**
 * 易变值掩码：把每秒都在变的读数归一，**只用于判断"这一行算不算变化"**。
 *
 * 掩码绝不作用于写进材料的文字——`spec.compose` 要求规则逐字引用证据，
 * 删掉数字会让规则失去出处。它只回答一个问题：倒计时从 05:40:16 走到 05:40:15，
 * 这算页面变了吗？不算。
 *
 * 形态要收窄，不能像 `numless` 那样对任意 `\d+` 一刀切——那会把
 * 「余额 0 → 100」「持仓 0 → 1」这类**真实**的状态变化也吃掉，
 * 而漏掉一个真实变化比多报一个难发现得多。
 */
export function maskVolatile(line: string): string {
  return line
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "〈时刻〉")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "〈时刻〉")
    .replace(/[+-]?\d{1,3}(,\d{3})*(\.\d+)?\s*%/g, "〈百分比〉")
    .replace(/\b\d{1,3}(,\d{3})+(\.\d+)?\b/g, "〈数值〉")
    .replace(/\b\d+\.\d{2,}\b/g, "〈数值〉");
}

/**
 * 一次动作让页面**哪里变了**。
 *
 * 这是探索产物里此前完全缺失的一维。没有它，转移只记着「点了什么」，
 * 记不下「于是什么变了」，而后者才是一条用户故事的内容。
 */
export interface ScreenDiff {
  controlsAdded: string[];
  controlsRemoved: string[];
  /** 同一个控件的状态变了：`Limit: selected=false → selected=true`。 */
  stateChanged: string[];
  textAdded: string[];
  textRemoved: string[];
  /** 掩码之后仍然有差异吗。没有就说明这次动作什么都没做成。 */
  changed: boolean;
}

/** 探索之前问模型拿到的业务判断与候选用户故事。 */
export interface ScenarioPlan {
  /** 这是什么产品的什么页面，一句话。 */
  business: string;
  stories: Array<{
    id: string;
    title: string;
    actor: string;
    goal: string;
    /** 这条故事要用到的控件编号（对应传给模型的那张编号清单）。 */
    controls: number[];
    priority: "P0" | "P1" | "P2";
  }>;
}

/**
 * 每个键都写进 `required`。
 *
 * 这个仓库实测过三次：**可选的键，这个模型直接不写**——`priority`、`postSteps`
 * 进了 properties 仍然一条都不产，而报告看起来完全正常。约束解码只是建议，
 * 唯一有效的强制是 required。
 */
const SCENARIO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["business", "stories"],
  properties: {
    business: { type: "string", description: "这是什么产品的什么页面，一句话，不要罗列数字" },
    stories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "actor", "goal", "controls", "priority"],
        properties: {
          id: { type: "string" },
          title: { type: "string", description: "一件具体的、能做完的事，动词开头" },
          actor: { type: "string" },
          goal: { type: "string", description: "他为什么要做这件事" },
          controls: { type: "array", items: { type: "integer" }, description: "只能引用清单里出现过的编号" },
          priority: { type: "string", enum: ["P0", "P1", "P2"] },
        },
      },
    },
  },
} as const;

/**
 * 问一次业务场景，把答案校验成探索计划。
 *
 * 给模型的是**编号 + 可见文案 + 所属组**，不给选择器、不给 DOM——
 * 让它做判断，不让它编事实。回来的编号对不上就整条丢掉，并记一条日志：
 * 一条引用不到任何真实控件的"用户故事"，下游没法验证，留着只会变成一条假证据。
 */
export async function askForScenarios(
  spec: ObserveSpec,
  // 结构化写法而不是引用 Control：那个接口声明在 runObserve 内部，
  // 这里只需要这三个字段。
  first: { url: string; title: string; elements: Array<{ label: string; group: string; selectedNow: boolean }> },
  note: (msg: string, level?: "info" | "warn") => void,
): Promise<ScenarioPlan | undefined> {
  if (!spec.ask) return undefined;
  const numbered = first.elements
    .map((e, i) => ({ i, e }))
    .filter(({ e }) => e.label.trim())
    .slice(0, 120);
  if (!numbered.length) return undefined;

  const groups = new Map<string, string[]>();
  for (const { i, e } of numbered) {
    const g = e.group || "（散控件）";
    groups.set(g, [...(groups.get(g) ?? []), `${i}. ${e.label}${e.selectedNow ? "（当前选中）" : ""}`]);
  }
  const inventory = [...groups.entries()]
    .map(([g, items]) => `【${g}】\n${items.join("\n")}`)
    .join("\n\n");

  const prompt = [
    "你在看一个网页应用的一屏。下面是它的地址、标题，以及这一屏上**可交互控件**的编号清单，按控件组分好了。",
    "",
    `地址：${first.url}`,
    `标题：${first.title}`,
    "",
    inventory,
    "",
    "回答两件事：",
    "1. business：这是什么产品的什么页面，一句话。**不要罗列屏幕上的数字**——行情、倒计时、余额这些每秒都在变，它们是数据不是功能。",
    "2. stories：人在这一屏上可能要完成的**具体的事**，每条给出它要用到的控件编号。",
    "",
    "写故事的要求：",
    "- 一条故事是一件**能做完的事**（「提交一张表单并看到新记录出现」「把一条记录改成另一种状态」），不是一个静态观察（「页面显示一个数字」）。",
    "- 只能引用上面出现过的编号。编不出编号的故事不要写。",
    "- 同一个控件组里的不同选项，往往对应不同的故事——那正是这个产品的业务分支。",
    "- 优先级按「不做这件事这个产品就没意义」来排。",
  ].join("\n");

  const raw = await spec.ask({ prompt, schema: SCENARIO_SCHEMA, maxTokens: 2400 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    note("业务场景：模型没有回出合法 JSON", "warn");
    return undefined;
  }
  const obj = parsed as Partial<ScenarioPlan>;
  if (!obj || typeof obj.business !== "string" || !Array.isArray(obj.stories)) {
    note("业务场景：回答少了 business 或 stories", "warn");
    return undefined;
  }
  const valid = new Set(numbered.map(({ i }) => i));
  const stories: ScenarioPlan["stories"] = [];
  for (const s of obj.stories) {
    const ctrls = (s?.controls ?? []).filter((n) => typeof n === "number" && valid.has(n));
    if (!ctrls.length) {
      note(`丢掉候选故事「${s?.title ?? "（无题）"}」：它引用的控件编号一个都对不上`, "warn");
      continue;
    }
    stories.push({
      id: String(s.id ?? `S-${stories.length + 1}`),
      title: String(s.title ?? ""),
      actor: String(s.actor ?? ""),
      goal: String(s.goal ?? ""),
      controls: ctrls,
      priority: (["P0", "P1", "P2"] as const).includes(s.priority as "P0") ? (s.priority as "P0") : "P1",
    });
  }
  return stories.length ? { business: obj.business, stories } : undefined;
}

/**
 * 把一次页内切换写成材料里的一段话。
 *
 * 写差异而不是整屏，是因为整屏里全是行情数字——下游只会又抓一遍 Funding 和 Countdown。
 * 写成"点了 X，于是 Y 出现了"这种因果形状，规格才可能整理出**行为**，
 * 而不是又一批"入口页显示 0.01000%"。
 */
export function describeEffect(label: string, group: string, d: ScreenDiff): string {
  const parts: string[] = [`（页内切换：在「${group}」里切到「${label}」）`];
  if (d.stateChanged.length) parts.push(`选中态变化：\n${d.stateChanged.map((s) => `  - ${s}`).join("\n")}`);
  if (d.controlsAdded.length) parts.push(`多出的控件：\n${d.controlsAdded.map((s) => `  + ${s}`).join("\n")}`);
  if (d.controlsRemoved.length) parts.push(`消失的控件：\n${d.controlsRemoved.map((s) => `  - ${s}`).join("\n")}`);
  if (d.textAdded.length) parts.push(`多出的文字（已滤掉每秒都在跳的读数）：\n${d.textAdded.slice(0, 12).map((s) => `  + ${s}`).join("\n")}`);
  return parts.join("\n");
}

export function diffScreens(
  before: { controls: string[]; states?: string[]; text: string },
  after: { controls: string[]; states?: string[]; text: string },
): ScreenDiff {
  const setOf = (xs: string[]): Set<string> => new Set(xs);
  const bC = setOf(before.controls);
  const aC = setOf(after.controls);
  const controlsAdded = [...aC].filter((x) => !bC.has(x)).slice(0, 40);
  const controlsRemoved = [...bC].filter((x) => !aC.has(x)).slice(0, 40);

  // 状态变化：按"控件文案"配对，比较它后面的状态串。
  const stateMap = (xs?: string[]): Map<string, string> =>
    new Map((xs ?? []).map((s) => { const i = s.indexOf("#"); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; }));
  const bS = stateMap(before.states);
  const aS = stateMap(after.states);
  const stateChanged: string[] = [];
  for (const [k, v] of aS) {
    const old = bS.get(k);
    if (old !== undefined && old !== v) stateChanged.push(`${k}: ${old || "（无）"} → ${v || "（无）"}`);
  }

  const lines = (t: string): string[] => t.split("\n").map((s) => s.trim()).filter(Boolean);
  const bT = setOf(lines(before.text).map(maskVolatile));
  const aT = setOf(lines(after.text).map(maskVolatile));
  const textAdded = lines(after.text).filter((l) => !bT.has(maskVolatile(l))).slice(0, 30);
  const textRemoved = lines(before.text).filter((l) => !aT.has(maskVolatile(l))).slice(0, 30);

  return {
    controlsAdded,
    controlsRemoved,
    stateChanged: stateChanged.slice(0, 40),
    textAdded,
    textRemoved,
    changed:
      controlsAdded.length > 0 || controlsRemoved.length > 0 || stateChanged.length > 0 || textAdded.length > 0,
  };
}

/**
 * 等页面自己安定下来，而不是等一个固定的秒数。
 *
 * 固定 1.5 秒对服务端渲染的页面够用，对客户端渲染的应用远远不够。
 * **实测 2026-09-01**：`demo.binance.com/en/futures/BTCUSDT` 在导航后 1.5 秒时
 * `innerText` 与可见控件数**都还是 0**；探索器于是把它当成一张空页面，顺着 DOM 里
 * 已有的链接走去了 `/en/login`，最后交出一份讲登录流程的材料——而项目指的是合约交易。
 *
 * 这正是本仓库反复记下的那个形状：**读空了页面的探索器不会报错，
 * 它会给你一份关于另一个产品的完整材料，而且看起来完全正常。**
 *
 * 判据改成「不再长」：连续两次采样，可见控件数与文本长度都不再增加就算安定。
 * `minMs` 是"至少等多久"，`maxMs` 是上限——等不到就走，
 * 但要把这件事说出来，而不是假装它安定了。
 */

export type ProbeVariant = "empty" | "malformed" | "unmatched";

/** 图里和日志里怎么称呼这三类实验。它会一路走进规格、故事、用例的措辞里。 */
const PROBE_WORDS: Record<ProbeVariant, string> = {
  empty: "空着提交",
  malformed: "填格式非法的值提交",
  unmatched: "填查不到的值提交",
};

/**
 * 「填查不到的值」只对**查询/登录**表单做。
 *
 * 这一类实验填的是**格式合法**的值——在一个新增/编辑表单上提交，它会通过校验然后
 * **真的写库**。那一刻探索就不再是观察：被测应用被改了，而基准应用的全部意义在于它
 * 冻结不变，两次跑的是同一个东西。（PetClinic 五次运行图完全一致、标准差为 0，
 * 正是这个性质的体现；一旦有写入，这个数就会开始飘，而且没人知道是哪一次飘的。）
 *
 * 而这一类实验真正想看的行为——「搜不到时说什么」「凭证错误时说什么」——本来就只
 * 出现在查询和登录上。所以限制不是妥协，是把它用在它成立的地方。
 *
 * 空提交和格式非法都不受限：它们的设计目的就是过不了校验，过不了就写不进去。
 */
export const LOOKUP_SUBMIT = /find|search|查找|搜索|检索|filter|筛选|log\s*in|sign\s*in|登录|登入/i;

/** 有格式的字段类别。纯文本不在其中：`<input type="text">` 填什么都不算格式错。 */
const FORMATTED = ["email", "tel", "number", "password", "url", "date"];

/**
 * 每一类字段的坏值。**确定性的表，不问模型。**
 *
 * `malformed` 要触发格式校验：电话填字母、密码只给一个字符、日期给 99/99/9999。
 * `unmatched` 要格式合法但系统里没有：一个不存在的邮箱、一个查不到的姓氏——
 * 「搜不到时提示什么」「凭证错误时提示什么」这两类行为只有这样才看得到。
 *
 * 邮箱的 `.invalid` 是 RFC 2606 保留的顶级域，永远不会解析到真实主机——
 * 一个基准应用的实验不该往任何真实地址发东西。
 */
export const BAD_VALUES: Record<string, { malformed: string; unmatched: string }> = {
  email: { malformed: "not-an-email", unmatched: "nobody@example.invalid" },
  tel: { malformed: "abcdef", unmatched: "0000000000" },
  number: { malformed: "abc", unmatched: "999999999" },
  password: { malformed: "x", unmatched: "wrongpassword123" },
  url: { malformed: "nope", unmatched: "https://example.invalid" },
  date: { malformed: "99/99/9999", unmatched: "1900-01-01" },
  text: { malformed: "", unmatched: "zzzznotaproduct" },
};

/**
 * 材料的字数预算。**按屏分，不从尾巴切。**
 *
 * 网关那边有一刀 `notes.slice(0, 60000)`。屏数只有 8 的时候它从不生效；探索改进到
 * 25–30 屏之后，它每次都生效——而**从尾巴切会整屏整屏地消失**。一次实测里 about 和
 * contact 两屏被整个切掉，材料里于是既没有 `Corporate History` 也没有 `CAPTCHA`，
 * 看起来像是探索没走到，其实走到了、记下了、然后在最后一步被丢掉。
 *
 * 从尾巴切还有一层更坏的性质：**丢掉的总是最后探索到的那些屏**，而那恰好是新加的
 * 「未访问路由优先」「全局队列」费力够到的部分。改进越有效，被丢掉的越多。
 *
 * 所以改成按屏分配：每屏一份等额预算，超了的屏自己截断并标明截断了多少。
 * 图和覆盖摘要不参与分配——它们是结构，一截就废。
 */
export function budgeted(screens: string[], graphText: string, coverage: string, total = 200000): string {
  const tail = `${graphText}\n\n${coverage}`;
  const room = Math.max(0, total - tail.length - 2);
  const joined = screens.join("\n\n");
  if (joined.length <= room) return `${joined}\n\n${tail}`;
  const per = Math.max(600, Math.floor(room / Math.max(1, screens.length)) - 2);
  const cut = screens.map((sc) =>
    sc.length <= per ? sc : `${sc.slice(0, per)}\n…（这一屏还有 ${sc.length - per} 字没写进来）`,
  );
  return `${cut.join("\n\n")}\n\n${tail}`;
}

export type Emit = (evt: Record<string, unknown>) => void;

/** Cooperative cancellation: the UI closing the stream must stop the work, not orphan it. */
export interface CancelToken {
  cancelled: boolean;
}

export interface ExploreSpec {
  execId: string;
  url: string;
  artifactDir: string;
  /** Fully composed prompt (settings template + language directive) — the gateway owns prompts. */
  prompt: string;
  /** Present when a deep crawl is requested: the prompt to use after advancing one screen. */
  deepPrompt?: string;
  /** Dapp explores wait for the app to detect the injected wallet before planning. */
  settleMs?: number;
  /** 安定等待的上限。到点还没安定就走人，并在轨迹里说出来。见 `settle`。 */
  maxSettleMs?: number;
  launch: LaunchOpts;
}

export interface ExploreResult {
  /** Raw flow objects from the model. Turning them into cases needs the DB, so the gateway does it. */
  flows: unknown[];
  log: string[];
  shotRef?: string;
}

export interface DebugSpec {
  execId: string;
  url: string;
  artifactDir: string;
  plan: Array<{ text: string; kind: "login" | "step" }>;
  expected?: string;
  /** Free-text hint passed to Midscene as action context. */
  hint?: string;
  resolve: ResolveContext;
  launch: LaunchOpts;
}

/**
 * 探索半成品的落点。**两侧共用这一个函数**：探索器往这里写，服务端从这里捡
 * （`workflowOps.readPartialObservation`）。
 *
 * 抽出来是因为这是个典型的会悄悄错开的接缝：两处各写一遍模板字符串，
 * 哪天改了目录名，写的一侧和读的一侧不会有任何一层报错——只是永远捡不到东西，
 * 而「捡不到」和「本来就没有」长得一模一样。
 */
export function partialObservationPath(artifactDir: string, execId: string): string {
  return resolve(artifactDir, "observe", `${execId}.partial.json`);
}

function shooter(spec: { execId: string; artifactDir: string }) {
  const dir = resolve(spec.artifactDir, "live");
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async (session: Session | undefined): Promise<string | undefined> => {
    if (!session) return undefined;
    try {
      const buf = await session.page.screenshot({ type: "jpeg", quality: 55 });
      const path = resolve(dir, `${spec.execId}-${n++}.jpg`);
      writeFileSync(path, buf);
      return path;
    } catch {
      return undefined; // a missed frame must never fail the session
    }
  };
}

export interface ObserveSpec {
  /** Gateway scope for scenario planning; never contains planner credentials. */
  projectId?: string;
  execId: string;
  url: string;
  artifactDir: string;
  /**
   * 一个控件组最多采几项。
   *
   * 组是 `role=tablist / radiogroup / menu / listbox` 这样的容器。给它配额是为了
   * 让一个装着几百个交易对的 listbox 不至于淹掉下单区那三项——而不是像以前那样
   * 按 DOM 顺序截前 60 个（交易页的下单区正好落在截断线之外）。
   */
  groupCap?: number;
  /**
   * 领域探索 charter（docs/v3/history/20 §6、21 §2）。
   *
   * 给了它，探索就按「规则包里的目标」决定先点什么：普通 button、checkbox、自定义控件
   * 都能匹配，不再只认带 ARIA 组的 tab；goto 只去 charter 允许的路由，全局导航不再把
   * 预算带走；每个目标都留下 attempted / observed_only / blocked / failed 的回执。
   * 不给它，下面的一切行为和以前完全一样——它是可消融的那个变量。
   */
  charter?: ExplorationCharter;
  /**
   * 页内元素优先于未去过的路由。
   *
   * `auto`（默认）按事实判：入口页有 ≥2 个控件组就认为"业务活在页内"。
   * 这条不能无脑翻转——`nextAction` 里"未去过的路由优先"那条规则是从多路由产品的
   * 实测里长出来的（30 屏花在一个页内状态上、另一条路由一次没去），翻死了会毁掉那些基准。
   */
  inPageFirst?: "auto" | "on" | "off";
  /**
   * 问模型一个问题，拿回结构化答案。**由调用方注入**。
   *
   * 为什么是注入而不是在这里 new 一个客户端：探索跑在 runner 进程里，
   * 那个进程根本没有 `ModelClient`（它只向网关领模型票），而且它的 `OPENAI_BASE_URL`
   * 被网关改写成了 Midscene 的 no-think 代理。网关侧才拿得到真端点，
   * 也才能把这次调用记进 Langfuse——Midscene 自己的 `ai*` 不在 trace 上。
   *
   * 不注入就整步跳过，退回今天的行为。这也正好是消融开关的天然形状。
   */
  ask?: (req: { prompt: string; imageDataUrl?: string; schema: unknown; maxTokens?: number }) => Promise<string>;
  /**
   * 探索之前先问一次"这是什么业务、可能有哪些用户故事"，并用答案决定先点什么。
   *
   * 默认开。关掉就退回"按控件表和 URL 队列决定"——那正是把一个合约交易页
   * 探索成一份登录流程材料的原因。
   */
  scenarioFirst?: boolean;

  /** 往前走，而不是只看入口页。关掉就退回单屏采集。 */
  deep?: boolean;
  settleMs?: number;
  /** 安定等待的上限。到点还没安定就走人，并在轨迹里说出来。见 `settle`。 */
  maxSettleMs?: number;
  /**
   * 最多采到几屏。
   *
   * 这是探索的**成本**闸：每往前一屏要花一次模型调用，本地模型一次几十秒。
   */
  maxScreens?: number;
  /**
   * 连续几轮没发现新界面就停。
   *
   * 不用「走满 N 轮」而用「连着 N 轮没有新东西」：一个产品有几屏事先不知道，
   * 走满固定轮数要么半途而废，要么在最后一屏上原地打转还要接着花钱。
   */
  dryRounds?: number;
  /**
   * 状态抽象的名字。见 `sfg.ts` 的 ABSTRACTIONS。
   *
   * 之所以是参数而不是写死：横比六种抽象的实证研究把它认定为测试有效性的**关键变量**，
   * 而且不同探索策略配不同的抽象。写死了既不能消融，也没法和别人的结果比。
   */
  stateAbstraction?: string;
  /**
   * 这个环境配好的登录步骤。
   *
   * 没有它时，探索只能猜——第一版猜的是「用页面上显示的测试凭证登录」，因为
   * SauceDemo 把账号密码印在登录页上。**绝大多数应用不会。** 而凭证本来就在环境里，
   * 执行用例时一直在用，只有探索没用它。
   *
   * `${env.*}` / `${secret.*}` 在这里解析后执行，日志里只留模板——和执行用例同一条规矩。
   */
  login?: string[];
  /**
   * 这个环境提供的前提名（环境设置里由人填，例如 `session`、`wallet-session`）。
   * 规则包里目标的 `requires` 对照的就是它。不给时按老规矩：配了登录步骤就提供 `session`。
   */
  capabilities?: string[];
  resolve?: ResolveContext;
  launch: LaunchOpts;
}

export interface ObserveResult {
  /** 观察到的界面材料，逐屏。原样，不经任何解释。 */
  notes: string;
  url: string;
  log: string[];
  shotRef?: string;
  /** 走到过几屏，以及为什么停下来——一份材料薄不薄，得能看出是产品小还是探索停早了。 */
  screens?: number;
  stoppedBecause?: string;
  /**
   * 探索为什么停下来，**结构化的那一份**。
   *
   * `stoppedBecause` 是一句中文，它被写进图 JSON、原样显示在界面上——
   * 于是英文界面里会突然冒出一句「采满 18 屏的上限」。在这里把语言从数据里摘出去：
   * 界面拿 kind 自己翻译，旧运行没有这个字段就回落到那句原文。
   */
  stopped?: { kind: string; n?: number };
  /** 走过的那张图。点和**边**都在——边此前是被丢掉的那一半。 */
  graph?: StateFlowGraph;
  /** charter 模式下的逐目标回执与覆盖计数；计数由代码算，不是模型自述。 */
  report?: ExplorationReport;
}

/**
 * 看一眼跑着的产品，把界面上有什么**原样**取回来。
 *
 * 和 `runExplore` 的关键区别：这里**不问模型「这该怎么测」**。采集是确定性的——标题、正文、
 * 每个可点可填的控件及其可见文案——因为下游 `spec.compose` 要求「逐字引用界面文案」，
 * 而一段被模型转述过的描述，引出来的文案是它记得的样子，不是屏幕上的样子。
 *
 * 唯一用到模型的地方是「往前走一屏」这个动作：登录之后的界面从入口页上看不见，
 * 而怎么登录需要看着页面判断。那是**操作**，不是解释。
 */
export async function runObserve(
  spec: ObserveSpec,
  emit: Emit,
  token: CancelToken = { cancelled: false },
): Promise<ObserveResult> {
  const shot = shooter(spec as unknown as ExploreSpec);
  const log: string[] = [];
  const note = (message: string, kind: "info" | "warn" = "info") => {
    log.push(message);
    emit({ type: "log", message, kind });
  };
  let session: Session | undefined;

  /**
   * 一屏上的一个控件。
   *
   * `selector` 是关键：**我们已经精确知道要点哪个元素了**，把它翻译成一句自然语言、
   * 再让一个看截图的模型去屏幕上找回来，是纯损失——而且它找不到 `data-test` 这种
   * 屏幕上根本不显示的名字时，不会报错，只会什么都不做。
   */
  interface Control {
    display: string;
    label: string;
    selector: string;
    href: string;
    external: boolean;
    clickable: boolean;
    /**
     * ARIA 角色（`tab` / `checkbox` / `radio` / `switch` / `option` …）。
     *
     * 加这一项的理由是实测出来的：`demo.binance.com` 的合约交易页上，
     * 现有选择器只认出 **7 个控件，而且全是 `<a>` 链接**——
     * Limit/Market/Conditional、TP/SL、Reduce-Only、Positions/Open Orders
     * 这些真正的交易控件全是带 `role` 的 `<div>`，**对探索器根本不存在**。
     * 于是它只能顺着链接爬到别的币对和登录页，交出一份关于登录流程的材料。
     */
    role: string;
    /** 这一项当前是不是被选中的那一个。广度优先时用它认出"基线是哪一项"。 */
    selectedNow: boolean;
    /**
     * 这个控件所在**容器**的文案（弹窗 / 抽屉 / 对话框），不在任何容器里就是空。
     *
     * charter 的 `match.within` 靠它区分「弹窗里的那个」。2026-09-12 实测：
     * `Buy / Long` 既是下单面板的方向切换、又是确认框的确认键，只按文案匹配点到哪个全看运气。
     */
    container: string;
    /**
     * 这个控件现在处于什么状态——选中、勾选、按下、展开、禁用，以及下拉当前选的是哪一项。
     *
     * **少了它，切换标签页对探索器是隐形的**：Limit 与 Market 的文案、位置、选择器
     * 全都不变，只有这一位不同。判重看不见它，一次成功的切换就被记成「没有新界面」，
     * 连续三次之后探索就结束了（dryLimit 默认 3）——这正是"只拿到 4 屏"的机制。
     *
     * 空串表示"这个控件没有状态可言"（普通链接、普通按钮）。
     */
    state: string;
    /**
     * 它属于哪个控件组（`role=tablist` / `radiogroup` / `menu` / `listbox`）。
     *
     * 组是广度优先的天然单位：一个 tablist 里的每一项都该被切一遍，
     * 而不是把整页 224 个"看起来能点"的元素铺开——那里面绝大多数是订单簿的行。
     */
    group: string;
    /** 这是个可填的输入框吗——做实验那一步要靠它。 */
    fillable: boolean;
    /**
     * 渲染宽度。只给「认不出名字的输入框」这条兜底规则用。
     *
     * Juice Shop 的搜索框折叠时只有 4px 宽——它在 DOM 里、也可见，但**填不进东西**，
     * 回车也不起作用。宽度是「这个框现在能不能用」最直接的证据。
     */
    width: number;
    /**
     * 这个字段**有没有格式**：邮箱、电话、数字、密码、网址、日期各有各的非法值，
     * 而纯文本没有——一个 `<input type="text">` 填什么都不算格式错。
     *
     * 做实验要按等价类分：空 / 格式非法 / 格式合法但查无此值。中间那一类只对有格式的
     * 字段成立，所以要在选动作之前就知道这一屏有没有这种字段，否则会白花一轮。
     */
    fieldKind: "email" | "tel" | "number" | "password" | "url" | "date" | "text" | "";
    /** 它属于哪个表单（表单元素的选择器）。同一个表单的字段要一起提交才有意义。 */
    form: string;
    /** 提交按钮。有它才提交得了。 */
    submit: boolean;
  }

  /** 一屏的事实：地址、标题、正文、可交互控件的可见文案。 */
  /** 这一趟探索用的安定等待。见模块顶部的 `settleOn`。 */
  const settle = async (why: string): Promise<void> => {
    const r = await settleOn(session!.page as unknown as { evaluate<T>(fn: () => T): Promise<T> }, {
      minMs: spec.settleMs ?? 600,
      maxMs: spec.maxSettleMs ?? 12_000,
    });
    if (!r.settled && r.controls === 0 && r.textLen === 0)
      note(`${why}：等了 ${Math.round(r.ms / 1000)} 秒，页面上仍然一个可见控件都没有`, "warn");
  };

  const snapshot = async (
    label: string,
  ): Promise<{
    text: string;
    url: string;
    title: string;
    controls: string[];
    /** 与 `controls` 平行的状态串。只有认得它的抽象会读——见 sfg.ts 的 `route+controls+state/norm`。 */
    states: string[];
    elements: Control[];
  }> => {
    const page = session!.page as unknown as {
      url(): string;
      title(): Promise<string>;
      evaluate<T>(fn: () => T): Promise<T>;
      evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
    };
    const title = await page.title().catch(() => "");
    const body = await page
      .evaluate(() => (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 4000))
      .catch(() => "");
    /**
     * 控件采集。
     *
     * **这里面一个具名的内部函数都不能有。** esbuild 的 keepNames 会把
     * `const f = (x) => …` 包成 `__name(f, "f")`，而 `__name` 只存在于打包产物里；
     * `page.evaluate` 传过去的是函数源码，到了页面里就是 `ReferenceError: __name is not defined`。
     * 一次实测里它表现为「0 个控件」，静悄悄的——所以下面的错误也不再吞掉。
     */
    const elements: Control[] = await page
      .evaluate(() =>
        [
          ...document.querySelectorAll(
            /**
             * **按 ARIA 角色收，不按 `cursor: pointer` 收。**
             *
             * 实测同一页（demo.binance.com 合约页）：标准标签 19 个，加上 ARIA 角色 38 个，
             * 而按 `cursor:pointer` 收会得到 **224 个**——多出来的绝大部分是订单簿的价格行，
             * 它们看起来能点，但不是"这一屏能做什么"。角色是作者自己声明的语义，
             * 比样式可靠得多。
             */
            "button, a, input, select, textarea, [role=button]," +
              "[role=tab],[role=checkbox],[role=radio],[role=switch]," +
              "[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]," +
              "[role=option],[role=combobox],[role=listbox],[role=slider]," +
              "[role=spinbutton],[role=searchbox],[role=textbox],[role=link]",
          ),
        ]
          /**
           * **只算看得见的。**
           *
           * 抽屉式菜单里的项一直在 DOM 里——把它们算进来有两个后果，都很坏：
           * ① 判重看不见「菜单打开了」这件事（控件集合前后一模一样），于是一次成功的点击
           *    被记成「没有新界面」；② 探索会去点一个屏幕上根本不存在的东西。
           * 采集这一层的契约是「这一屏上有什么」，隐藏的东西不在这一屏上。
           */
          .filter((el) => {
            const e = el as HTMLElement;
            if (typeof e.checkVisibility === "function" && !e.checkVisibility()) return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          /*
           * 不再按 DOM 顺序硬截前 60 个。
           *
           * 交易页的 DOM 前 60 个几乎全是顶栏与币种导航，下单区整块落在截断线之外——
           * 而采不到时代码不报错，表现成"这一屏就这些控件"。改成先全收（上限 400 防病理页面），
           * 分组配额在下面 map 之后做，因为要先知道每个控件属于哪个组。
           */
          .slice(0, 400)
          .map((el) => {
            const e = el as HTMLElement & { placeholder?: string; type?: string; href?: string };
            /**
             * **按钮类 `<input>` 的文案在 `value` 里。**
             *
             * `<input type="submit" value="Sign In">` 屏幕上明明写着 Sign In，但 `<input>`
             * 没有 `innerText`——四样兜底全空，它于是被无文案过滤整条丢掉。dimeshift 的
             * 登录、注册全是这种按钮，结果是**提交按钮对探索不存在**，
             * `find(e => e.submit && e.form)` 永远找不到东西，一条实验都做不了。
             * PetClinic 和 Juice Shop 都用 `<button>`，所以这个洞一直没露出来。
             *
             * 只对 submit/button/reset 读 `value`：文本框的 `value` 是**用户填的内容**，
             * 不是文案，拿它当文案会把数据泄进材料，也会让同一个框在填了不同东西之后
             * 变成不同的控件。
             */
            const btnValue =
              el.tagName.toLowerCase() === "input" && ["submit", "button", "reset"].includes((e.type || "").toLowerCase())
                ? ((e as HTMLInputElement).value || "").trim()
                : "";
            /**
             * **输入框的文案在它的 `<label>` 上。**
             *
             * `<label><input type=checkbox> Reduce Only</label>` 是表单最常见的写法：
             * 输入框自己没有一个字，四样兜底全空，于是它被记成「（无可见文案·输入框）」——
             * 领域目标「Reduce Only」永远匹配不上它，价格 / 数量 / 杠杆三个框也全是无名氏。
             * 屏幕上明明写着字，只是写在旁边。先看包裹它的 label，再看 `label[for]`。
             * 这一条改变了控件文案，所以 collector 版本跟着升到 v3。
             */
            const labelText = ((): string => {
              if (!["input", "select", "textarea"].includes(el.tagName.toLowerCase())) return "";
              const wrap = el.closest("label") as HTMLElement | null;
              const forOne = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null) : null;
              const src = wrap ?? forOne;
              if (src) {
                // 只取 label 自己的文字，不带里面控件（按钮）的文案。
                const own = [...src.childNodes].filter((n) => n.nodeType === 3).map((n) => (n.textContent ?? "").trim()).filter(Boolean).join(" ").slice(0, 60);
                if (own) return own;
              }
              /**
               * 没有 label 的输入框：看它左边那个兄弟。
               *
               * app.hyperliquid.xyz 的 Size / Price 框既无 label、placeholder，也无 aria-label，
               * 「Size」是并排的一个 div。只认很短的兄弟文字（≤24 字），长了就不是标签。
               */
              const prev = (el.previousElementSibling as HTMLElement | null)?.innerText?.trim() ?? "";
              if (prev && prev.length <= 24 && !/\d{3,}/.test(prev)) return prev.slice(0, 60);
              const firstInParent = (el.parentElement?.firstElementChild as HTMLElement | null);
              const head = firstInParent && firstInParent !== el ? (firstInParent.innerText?.trim() ?? "") : "";
              return head && head.length <= 24 && !/\d{3,}/.test(head) ? head.slice(0, 60) : "";
            })();
            const label =
              (e.innerText || "").trim() ||
              btnValue ||
              e.getAttribute("aria-label") ||
              e.placeholder ||
              labelText ||
              e.getAttribute("name") ||
              "";
            // 站外链接标出来。不标，探索会顺着页脚的社交链接走出这个产品。
            let external = false;
            let path = "";
            try {
              if (e.href) {
                const u = new URL(e.href, location.href);
                external = u.origin !== location.origin;
                /**
                 * **哈希路由要留住。**
                 *
                 * 和 `routeOf` 当初一模一样的错，只是在另一个地方：单页应用的侧边栏里，
                 * Contact 是 `/#/contact`、About 是 `/#/about`——丢掉哈希，它们连同
                 * 首页链接一起全都塌成 `/`，`triedGoto` 去重后只剩一个。实测里探索点开了
                 * 侧边栏，下一步却是 `goto: /`，然后再也没回去：注册、联系、关于三页
                 * 一次都没走到，而它们是五次全漏里的三条。
                 *
                 * `#section` 这种纯锚点仍然不算，判据同样是那个 `/`。
                 */
                if (!external) path = u.pathname + u.search + (u.hash.startsWith("#/") ? u.hash : "");
              }
            } catch {
              external = false;
            }
            /**
             * 没有可见文案的控件，用 title / data-test / href 兜底——但**必须标明它不是文案**。
             *
             * SauceDemo 的购物车是个纯图标 `<a>`：`innerText` 为空，不兜底它就整条丢失，
             * 而它是通往购物车与结账三步的唯一入口。但兜底来的名字不能冒充界面文案：
             * 实测里 `data-test="login-button"` 就这样一路漏进材料 → 规格 → 断言，
             * 产出了一条「页面显示 'login-button'」的用例——它执行时必然失败，而且失败得
             * 毫无道理，因为屏幕上从来没有这几个字。整个下游的设计基础是「逐字引用界面文案」，
             * 材料把内部标识符冒充成文案，后面每一层都会当真。
             */
            const tagName = el.tagName.toLowerCase();
            const fallback = e.getAttribute("title") || e.getAttribute("data-test") || path;
            /**
             * **可填的输入框即使一个字都没有，也不能丢。**
             *
             * 下面那道 `.filter(c => c.label.trim())` 是为了挡掉垃圾可点元素。但
             * Juice Shop 的搜索框没有 aria-label、没有 placeholder、没有 id、没有 title
             * ——四样兜底全空，于是它被整条过滤掉，对整个探索**不存在**。搜索这一整块
             * 行为（「搜不到时说什么」）因此永远做不了实验。
             *
             * 一个输入框的用途是**被填**，不是被读。没有文案不代表它不重要，
             * 只代表这个产品没给它文案。仍然按老规矩标明这不是界面文案。
             */
            const anonInput =
              (tagName === "input" && !["submit", "button", "reset", "hidden"].includes((e.type || "").toLowerCase())) ||
              tagName === "textarea";
            const shown =
              label || (fallback ? `（无可见文案·${fallback}）` : anonInput ? "（无可见文案·输入框）" : "");
            const tag = el.tagName.toLowerCase();

            // 这个元素怎么再找回来：data-test → id → 一条 nth-of-type 路径。内联，见上面那段。
            let selector = "";
            const dt = el.getAttribute("data-test");
            if (dt) selector = `[data-test="${dt}"]`;
            else if (el.id) selector = `#${CSS.escape(el.id)}`;
            else {
              const parts: string[] = [];
              let node: Element | null = el;
              while (node && node !== document.body && parts.length < 6) {
                const parent: Element | null = node.parentElement;
                if (!parent) break;
                const t = node.tagName.toLowerCase();
                const same = [...parent.children].filter((c) => c.tagName === node!.tagName);
                parts.unshift(`${t}:nth-of-type(${same.indexOf(node) + 1})`);
                node = parent;
              }
              selector = parts.length ? `body ${parts.join(" > ")}` : tag;
            }

            const type = (e.type || "").toLowerCase();
            const form = el.closest("form");
            let formSel = "";
            if (form) {
              const fdt = form.getAttribute("data-test");
              const fid = form.id;
              formSel = fdt ? `[data-test="${fdt}"]` : fid ? `#${CSS.escape(fid)}` : "form";
            }
            /**
             * 角色、选中态、所属组——这三样是"页内状态"能被看见的全部依据。
             *
             * 组用最近的一个 `tablist / radiogroup / menu / listbox` 祖先来认，
             * 并用它自己的可读名字（`aria-label` 或第一项的文案）作 id：
             * 一页上往往有好几个 tablist（下单类型、图表、账户面板各一个），
             * 不区分开就没法说"把这一组挨个切一遍"。
             */
            const roleAttr = (e.getAttribute("role") || "").toLowerCase();
            /**
             * 状态串只收**语义明确**的几样，绝不把整串 class 拼进来。
             *
             * CSS-in-JS 的哈希类名每次构建都变，混进签名会让同一屏每次刷新都成为新状态——
             * 那是抽象过紧的另一头，和今天"过松"一样坏。class 只认白名单里的那几个词。
             */
            const bits: string[] = [];
            for (const a of ["aria-selected", "aria-checked", "aria-pressed", "aria-expanded", "aria-current"]) {
              const v = e.getAttribute(a);
              if (v !== null) bits.push(`${a.replace("aria-", "")}=${v}`);
            }
            if (e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true") bits.push("disabled");
            if (tag === "input" && ["checkbox", "radio"].includes(type))
              bits.push(`checked=${(e as HTMLInputElement).checked}`);
            if (tag === "select") {
              const s = e as unknown as HTMLSelectElement;
              bits.push(`chosen=${(s.selectedOptions?.[0]?.text ?? "").trim().slice(0, 24)}`, `opts=${s.options?.length ?? 0}`);
            }
            const cls = typeof (e as unknown as { className?: unknown }).className === "string" ? (e.className as string) : "";
            const marked = cls.match(/(^|[-_\s])(active|selected|checked|current|on)([-_\s]|$)/i);
            if (marked) bits.push(`cls:${marked[2].toLowerCase()}`);
            const ariaSel = e.getAttribute("aria-selected") ?? e.getAttribute("aria-checked") ?? e.getAttribute("aria-pressed");
            const groupEl = e.closest("[role=tablist],[role=radiogroup],[role=menu],[role=listbox],[role=group]");
            let groupId = "";
            if (groupEl) {
              const gl = groupEl.getAttribute("aria-label") || "";
              const first = (groupEl.querySelector("[role=tab],[role=radio],[role=option],[role=menuitem]") as HTMLElement | null)?.innerText ?? "";
              groupId = `${groupEl.getAttribute("role")}:${(gl || first || "").trim().slice(0, 24)}`;
            }
            return {
              /**
               * `display` 是**界面上看得见的东西**，一个字都不许加内部标记。
               *
               * 选中态、角色这些走下面的 `state` / `role` 字段。理由是这个文件 :429-441
               * 记着的那次事故：`data-test="login-button"` 冒充过文案，一路漏进材料，
               * 最后产出一条必然失败的断言。签名需要选中态，材料不需要——两者分开走。
               */
              display: `${tag}${e.type ? `[${e.type}]` : ""}${external ? "[外站]" : ""}: ${shown.slice(0, 60)}${path ? ` -> ${path}` : ""}`,
              label: shown.slice(0, 60),
              selector,
              href: path,
              external,
              role: roleAttr,
              state: bits.join(","),
              selectedNow: ariaSel === "true",
              group: groupId,
              /**
               * 往上找最近的「容器」：带 dialog/alertdialog 角色、aria-modal、class 里带
               * modal/dialog/popup/drawer 的祖先，**或者长得像浮层的祖先**——定位 + z-index≥10 + 够大。
               * 最后这条是被真产品逼出来的：Hyperliquid 的确认框三样 ARIA 标记一个都没有
               * （2026-09-12 在 testnet 页面上查过），只认 ARIA 的话容器判据在它身上等于没写。
               * 找不到就是空——空意味着「不在任何弹窗里」，这正是 within 要区分的那件事。
               * 下面 charter 文案扫的那一路有同样一段，改这里要一起改。
               */
              container: ((): string => {
                let n: HTMLElement | null = el as HTMLElement;
                for (let i = 0; n && i < 12; i++, n = n.parentElement) {
                  const role = n.getAttribute?.("role") || "";
                  const cls = typeof n.className === "string" ? n.className : "";
                  const st = getComputedStyle(n);
                  const floats = (st.position === "fixed" || st.position === "absolute")
                    && (parseInt(st.zIndex || "0", 10) || 0) >= 10 && n.offsetWidth >= 200 && n.offsetHeight >= 100;
                  if (role === "dialog" || role === "alertdialog" || n.getAttribute?.("aria-modal") === "true" ||
                      /modal|dialog|popup|drawer|overlay/i.test(cls) || floats)
                    return (n.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
                }
                return "";
              })(),
              // 能填的：文本类 input、textarea、select。checkbox/radio 这一版先不管——
              // 它们的「坏值」不是空字符串，需要另一套判断。
              width: Math.round(el.getBoundingClientRect().width),
              fillable:
                (tag === "input" && !["submit", "button", "reset", "hidden", "checkbox", "radio", "file"].includes(type)) ||
                tag === "textarea",
              /**
               * 字段类别：先信 `type`，再看名字。
               *
               * 很多表单把邮箱写成 `<input type="text" name="email">`——只看 type 会把
               * 它当纯文本，于是「填个非法邮箱」这一类实验对它永远做不了。名字、id、
               * placeholder、aria-label 四个一起看，命中哪个都算。
               */
              fieldKind: ((): Control["fieldKind"] => {
                if (["email", "tel", "number", "password", "url", "date"].includes(type))
                  return type as Control["fieldKind"];
                if (tag === "textarea") return "text";
                if (tag !== "input") return "";
                const hint = [
                  e.getAttribute("name") || "",
                  el.id || "",
                  e.placeholder || "",
                  e.getAttribute("aria-label") || "",
                ]
                  .join(" ")
                  .toLowerCase();
                if (/mail/.test(hint)) return "email";
                if (/phone|tel(?!e?metry)|mobile|电话|手机/.test(hint)) return "tel";
                if (/pass|密码/.test(hint)) return "password";
                if (/\burl\b|website|homepage|网址/.test(hint)) return "url";
                if (/date|birth|日期|生日/.test(hint)) return "date";
                if (/\bnum|qty|quantity|amount|zip|postal|数量|金额|邮编/.test(hint)) return "number";
                return "text";
              })(),
              form: formSel,
              /**
               * **表单外的 `<button>` 不是提交控件。**
               *
               * HTML 把没写 type 的 button 默认成 submit，但提交这件事只在 `<form>` 里才存在。
               * 实测 perp-lab（2026-09-10）：Limit / Isolated / TP-SL 这些切换按钮全是裸 `<button>`，
               * 被记成 submit 之后，charter 的「不点提交控件」把整个交易面板拦住了——
               * 而通用遍历档不看这一位，照点不误，回执里却一条都没有。
               */
              submit: !!form && (type === "submit" || (tag === "button" && (el.getAttribute("type") || "submit") === "submit")),
              clickable:
                /^(button|a)$/.test(tag) ||
                e.type === "submit" ||
                e.type === "button" ||
                el.getAttribute("role") === "button",
            };
          })
          .filter((c) => c.label.trim()),
      )
      .catch((err: Error) => {
        // 采不到控件不是「这一屏没有控件」。不说出来，它会变成一份看起来正常、
        // 只是什么都探索不动的材料。
        note(`控件采集失败：${String(err).slice(0, 120)}`, "warn");
        return [] as Control[];
      });
    /**
     * **charter 目标文案驱动的补采：自定义控件。**
     *
     * 按 ARIA 角色采集是对的（否则订单簿几百行都成了控件），但 app.hyperliquid.xyz 的
     * Market / Limit / Pro、Buy / Sell、Reduce Only、TP/SL、底部面板 tab 全是无 role 的
     * `div`，对采集器不存在——实测这一页只认出 27 个控件，交易面板一个都不在。
     * 有 charter 时，用目标的文案正则去认 `cursor: pointer` 的叶子元素；只认命中的，
     * 所以不会把整页可点的东西都铺开。没有 charter 时这一段不跑，旧行为不变。
     */
    const extra: Control[] = spec.charter
      ? await page
          .evaluate(
            (patterns: string[]) => {
              const res: string[][] = [];
              const seen = new Set<string>();
              for (const el of document.querySelectorAll("body *")) {
                const e = el as HTMLElement;
                const tag = el.tagName.toLowerCase();
                if (["svg", "path", "g", "script", "style", "input", "select", "textarea", "button", "a"].includes(tag)) continue;
                if (el.getAttribute("role")) continue;
                if (typeof e.checkVisibility === "function" && !e.checkVisibility()) continue;
                const r = e.getBoundingClientRect();
                if (!(r.width > 0 && r.height > 0)) continue;
                if (getComputedStyle(e).cursor !== "pointer") continue;
                const text = (e.innerText || "").trim().replace(/\s+/g, " ");
                if (!text || text.length > 60) continue;
                if (!patterns.some((p) => { try { return new RegExp(p, "i").test(text); } catch { return false; } })) continue;
                // 取叶子：孩子里有同样文字的，说明这一层只是容器。
                if ([...el.children].some((c) => ((c as HTMLElement).innerText || "").trim().replace(/\s+/g, " ") === text)) continue;
                const parts: string[] = [];
                let node: Element | null = el;
                while (node && node !== document.body && parts.length < 8) {
                  const parent: Element | null = node.parentElement;
                  if (!parent) break;
                  const t = node.tagName.toLowerCase();
                  const same = [...parent.children].filter((c) => c.tagName === node!.tagName);
                  parts.unshift(`${t}:nth-of-type(${same.indexOf(node) + 1})`);
                  node = parent;
                }
                const selector = parts.length ? `body ${parts.join(" > ")}` : tag;
                if (seen.has(selector)) continue;
                seen.add(selector);
                const bits: string[] = [];
                for (const a of ["aria-selected", "aria-checked", "aria-pressed", "aria-expanded", "data-state"]) {
                  const v = e.getAttribute(a);
                  if (v !== null) bits.push(`${a.replace("aria-", "").replace("data-", "")}=${v}`);
                }
                const cls = typeof (e as unknown as { className?: unknown }).className === "string" ? (e.className as string) : "";
                const marked = cls.match(/(^|[-_\s])(active|selected|checked|current|on)([-_\s]|$)/i);
                if (marked) bits.push(`cls:${marked[2].toLowerCase()}`);
                // 容器文案：charter 的 `match.within` 靠它区分「弹窗里的那个」。判据与上面那一路一致。
                const container = ((): string => {
                let n: HTMLElement | null = el as HTMLElement;
                for (let i = 0; n && i < 12; i++, n = n.parentElement) {
                  const role = n.getAttribute?.("role") || "";
                  const cls = typeof n.className === "string" ? n.className : "";
                  const st = getComputedStyle(n);
                  const floats = (st.position === "fixed" || st.position === "absolute")
                    && (parseInt(st.zIndex || "0", 10) || 0) >= 10 && n.offsetWidth >= 200 && n.offsetHeight >= 100;
                  if (role === "dialog" || role === "alertdialog" || n.getAttribute?.("aria-modal") === "true" ||
                      /modal|dialog|popup|drawer|overlay/i.test(cls) || floats)
                    return (n.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
                }
                return "";
              })();
                res.push([tag, text.slice(0, 60), selector, bits.join(","), String(Math.round(r.width)), container]);
              }
              return res;
            },
            spec.charter.featureTargets.flatMap((t) => t.match.label),
          )
          .then((rows) =>
            rows
              .filter(([, , selector]) => !elements.some((c) => c.selector === selector))
              .map(([tag, text, selector, state, width, container]): Control => ({
                display: `${tag}: ${text}`,
                label: text!,
                selector: selector!,
                container: container ?? "",
                href: "",
                external: false,
                role: "",
                state: state!,
                selectedNow: /selected=true|checked=true|cls:(on|active|selected)/.test(state!),
                group: "",
                width: Number(width),
                fillable: false,
                fieldKind: "",
                form: "",
                submit: false,
                clickable: true,
              })),
          )
          .catch((err: Error) => {
            note(`charter 补采失败：${String(err).slice(0, 120)}`, "warn");
            return [] as Control[];
          })
      : [];
    if (extra.length) elements.push(...extra);
    /**
     * 组配额：一个控件组最多留 `groupCap` 项，其余按顺序丢，但**把丢了多少记下来**。
     *
     * 一页上可能有一个装着几百个交易对的 listbox；把它整组铺开会淹掉下单区那三项。
     * 但静默丢弃和当初按 DOM 顺序硬截是同一个错，所以丢了要说得出来。
     */
    const cap = Math.max(1, spec.groupCap ?? 6);
    const perGroup = new Map<string, number>();
    const dropped = new Map<string, number>();
    const kept: Control[] = [];
    for (const e of elements) {
      if (!e.group) {
        if (kept.length < 200) kept.push(e);
        continue;
      }
      const n = (perGroup.get(e.group) ?? 0) + 1;
      perGroup.set(e.group, n);
      if (n <= cap) kept.push(e);
      else dropped.set(e.group, (dropped.get(e.group) ?? 0) + 1);
    }
    for (const [g, n] of dropped) note(`控件组 ${g} 有 ${n} 项没进这一屏（每组最多 ${cap} 项）`, "warn");

    const controls = kept.map((e) => e.display);
    /** 与 `controls` 平行的状态串。签名用它，材料不用——见 Control.state。 */
    const states = kept.map((e) => (e.state ? `${e.display}#${e.state}` : e.display));

    return {
      url: page.url(),
      title,
      controls,
      states,
      elements: kept,
      text: [
        `===== ${label} =====`,
        `URL: ${page.url()}`,
        title ? `TITLE: ${title}` : "",
        "",
        "TEXT:",
        body,
        "",
        "CONTROLS:",
        ...controls.map((c) => `- ${c}`),
      ]
        .filter((x) => x !== "")
        .join("\n"),
    };
  };

  /**
   * 这一屏是不是没见过的——由**状态抽象**决定。
   *
   * 这把尺子松紧直接决定探索的成败：过松会把没探索过的当成已探索（漏测），
   * 过紧会把探索过的当成新的（冗余，原地打转）。今天这两种我都撞过一次。
   * 所以它是可替换的一族函数，名字随图一起记下来。
   */
  // charter 模式默认用看得见选中态的那把尺子：合约页的业务全在页内切换里，
  // 只看控件集合的尺子会把每一次成功的切换记成「没有新界面」。显式传了名字仍以传的为准。
  const abstractionName = spec.stateAbstraction ?? (spec.charter ? "route+controls+state/norm" : undefined);
  const abstract = abstractionOf(abstractionName);
  const signatureOf = (screen: { url: string; controls: string[]; title?: string; states?: string[] }): string =>
    abstract(screen);

  try {
    emit({ type: "start", url: spec.url });
    session = await launchSession(spec.url, spec.launch);
    emit({ type: "navigated", shotRef: await shot(session) });
    await settle("入口页");

    /**
     * 探索是一个循环，不是「看两眼」。
     *
     * 此前这里只往前走一屏就收工：对任何一个登录页之后还有几屏的产品，材料里都缺着大半，
     * 而缺的那部分在下游看不出来——规格照样整理得出来，用例照样生成得出来，只是**系统性地
     * 少了那几屏对应的一切**，最后表现为一个没有解释的覆盖率数字。
     *
     * **去哪由代码决定，`aiAction` 只收一个具体动作。**
     * 第一版把目标、策略和禁令写进一次 `aiAction`，Midscene 拆不动，replan 十次就放弃，
     * 一轮白烧七分钟——`Replanning 10 times, which is more than the limit`。它要的是
     * 「点某个按钮」这种一句话能说完的事，不是「你去把这个应用看一遍」。
     * 下一步点什么，从**已经确定性采到的控件表**里挑，不用再问一次模型：
     * 「这一屏还有哪个没点过」是个查得出来的事实。
     */
    const maxScreens = Math.max(1, spec.maxScreens ?? 6);
    const dryLimit = Math.max(1, spec.dryRounds ?? 3);
    /**
     * 一轮走一个控件，所以动作预算比屏数宽——有些点击不会换屏。
     * 同源链接走 `goto`，一次几乎不花时间，所以这个预算可以给得比屏数宽得多。
     */
    const maxRounds = maxScreens * 5;

    /** 点了会把这次探索本身毁掉的（退出登录）或不可逆的，不点。 */
    const OFF_LIMITS = /log\s*out|sign\s*out|logout|退出|注销|delete|remove|reset|清空|删除/i;
    /**
     * 不是界面的地址。
     *
     * PetClinic 的兽医列表页链到 `/vets.xml` 和 `/vets.json`——那是同一份数据的 API 表示，
     * 不是一屏。跟过去，图里就多两个"状态"，规格里就多两条关于 XML 的规则，
     * 而它们对**界面**测试毫无意义。判据用扩展名，是因为它查得出来：
     * 一个 `.json` 结尾的地址不会是给人看的页面。
     */
    const NOT_A_SCREEN = /\.(json|xml|csv|pdf|zip|png|jpe?g|gif|svg|ico|txt|md|yml|yaml|rss|atom)(\?|$)/i;

    /**
     * 每一屏上看得见的同源链接。
     *
     * 探索按地址全局记「去过没去过」，所以一个页面只会被从某一处进入一次——图里因此只留下
     * 遍历实际走的那条边，**退化成一棵生成树**。PetClinic 每页都有全局导航栏，最短路径
     * 在生成树上算出来还是遍历顺序：「访问错误演示页：/owners/find → /vets → /oups」。
     *
     * 这里把每一屏上的链接都记下来，最后补成边。零额外导航——信息本来就在快照里。
     */
    const linksSeen = new Map<string, Set<string>>();
    const noteLinks = (screen: { url: string; elements: Control[] }, id: string): void => {
      const here = pathOf(screen.url);
      const set = linksSeen.get(id) ?? new Set<string>();
      for (const c of screen.elements)
        if (c.href && c.href !== here && !c.external && !NOT_A_SCREEN.test(c.href) && !OFF_LIMITS.test(c.display)) {
          set.add(c.href);
          if (!triedGoto.has(c.href)) frontier.add(c.href);
        }
      linksSeen.set(id, set);
    };

    const first = await snapshot("入口页");
    const entryRoute = pathOf(first.url);
    /**
     * charter 记账。有 charter 时不再问模型猜故事：候选任务来自规则包，真正的故事
     * 等产品模型出来之后才写。`session` 这个前提只在环境配了登录步骤时算满足。
     */
    const tracker = spec.charter ? new CharterTracker(spec.charter, spec.capabilities ?? (spec.login?.length ? ["session"] : [])) : undefined;
    if (spec.charter) note(`charter ${spec.charter.id}：${spec.charter.featureTargets.length} 个目标，规则包 ${spec.charter.rulePack.id}@${spec.charter.rulePack.version}`);
    let charterShots = 0;
    const charterShot = async (): Promise<string | undefined> => {
      if (!session) return undefined;
      try {
        const dir = resolve(spec.artifactDir, "charter");
        mkdirSync(dir, { recursive: true });
        const path = resolve(dir, `${spec.execId}-${charterShots++}.jpg`);
        writeFileSync(path, await session.page.screenshot({ type: "jpeg", quality: 60 }));
        return path;
      } catch {
        return undefined;
      }
    };

    /**
     * **探索之前先问一次：这是什么业务，人在这里可能要完成哪些事。**
     *
     * 为什么要有这一步：此前整条循环里唯一的模型调用是"登录"，去哪、点什么全由
     * 控件表和 URL 队列决定。对一个只有一条 route、业务全在页内的产品，
     * 这等于让探索去数链接——实测把一个合约交易页探索成了一份登录流程的材料。
     *
     * 模型在这里**只做判断，不做事实**：它拿到的是截图和一张编号控件清单，
     * 回来的是"哪几个编号合起来是一件事"。编号对不上的整条丢掉——这是这条流水线
     * 已有的规矩（`spec.compose` 就是这么丢掉模型自己编的 flow 的）。
     * 具体点哪个、怎么点，仍然由代码按选择器执行。
     */
    let plan: ScenarioPlan | undefined;
    if (spec.ask && spec.scenarioFirst !== false && !spec.charter) {
      plan = await askForScenarios(spec, first, note).catch((e) => {
        note(`问业务场景失败，退回按控件表探索：${(e as Error).message}`, "warn");
        return undefined;
      });
      if (plan) {
        note(`业务：${plan.business}`);
        for (const s of plan.stories) note(`候选故事 ${s.id} · ${s.title}（${s.controls.length} 个控件）`);
      }
    }

    const screens: string[] = [first.text];
    /**
     * **每采到一屏就把已有的材料落一次盘。**
     *
     * 2026-09-14 调研出来的：探索是九个节点里唯一一个「中途挂 = 全丢」的，而它同时是最长的
     * 一个——这次的材料 187,669 字，跑满 20 屏要几十分钟加一次钱包会话。整份结果只在函数
     * 返回时才组装、才交给服务端落账本，所以第 18 屏上崩掉，前 17 屏花掉的十几次模型调用
     * 全部作废，resume 从第 1 屏重来。（2026-09-12 还因为收尾时 runner 被心跳看门狗 SIGKILL，
     * 一晚上丢过四次完整探索。）
     *
     * 只落**材料**，不落状态图：`graph` 要到循环跑完才建得出来，而材料就是钱花在的地方。
     * 写法是「先写临时文件再 rename」——崩在写一半上会留下半个 JSON，那比没有更糟。
     *
     * 这不是断点续跑：探索不会从第 18 屏接着走（那要动状态机，是另一件事）。
     * 它只保证**已经花掉的钱不白花**，以及下游拿到的材料上写着它只到第几屏。
     */
    const partialPath = partialObservationPath(spec.artifactDir, spec.execId);
    const snapshotPartial = (): void => {
      try {
        mkdirSync(dirname(partialPath), { recursive: true });
        const body = JSON.stringify({
          partial: true,
          at: new Date().toISOString(),
          url: spec.url,
          screens: screens.length,
          notes: budgeted(screens, "", `===== 这次探索停在第 ${screens.length} 屏 =====`),
        });
        writeFileSync(`${partialPath}.tmp`, body);
        renameSync(`${partialPath}.tmp`, partialPath);
      } catch { /* 落盘失败不能带垮探索本身——它是附加物，不是判决 */ }
    };
    snapshotPartial();

    const seen = new Set([signatureOf(first)]);
    const visited: string[] = [first.url];
    const missed: string[] = [];

    /**
     * 边走边建的状态转移图。
     *
     * 每一轮我们都清楚「在 A 状态做了什么、到了 B 状态」——此前这个三元组一次都没写下来，
     * 于是产出的材料只剩一张张屏幕的静态清单，下游整理出的规格里一条转移都没有。
     * 记边不花任何额外调用：它全部来自循环自己已有的变量。
     */
    const sfgStates: SfgState[] = [];
    const sfgEdges: SfgTransition[] = [];
    /** 签名 → 稳定 id。同一路由的不同可见状态编号区分，而不是当成另一条路由。 */
    const idBySig = new Map<string, string>();
    const idFor = (screen: { url: string; controls: string[]; title?: string }): string => {
      const sig = signatureOf(screen);
      const known = idBySig.get(sig);
      if (known) return known;
      const route = pathOf(screen.url);
      const nth = sfgStates.filter((st) => st.route === route).length;
      // 消歧符是 `~` 不是 `#`：单页应用的路由本身就带 `#`（`/#/search`），
      // 再用 `#` 分隔会让 `split("#")[0]` 拿到空串——同一路由的第二个状态从此没有路由。
      const id = nth === 0 ? route : `${route}~${nth}`;
      idBySig.set(sig, id);
      sfgStates.push({
        id,
        route,
        title: screen.title ?? "",
        controls: screen.controls.slice(0, 200),
      });
      return id;
    };
    let currentId = idFor(first);
    if (tracker) {
      const found = tracker.noteState(currentId, entryRoute, first.elements, 0);
      note(`入口页命中 ${found.length} 个 charter 目标：${found.map((t) => `${t.targetSpecId}=「${t.label}」`).join("，") || "（无）"}`);
    }
    /**
     * 试过什么，按**地址**记，不按屏幕签名记。
     *
     * 第一版按签名记，于是菜单一打开签名就变，同一个「Open Menu」在新签名下又成了没试过的
     * ——菜单开↔关来回抖，每一轮都把对方的控件当成新的，探索原地转圈直到 dry 用尽。
     * 签名的用途是「这算不算一屏新的」，不是「我做过什么」；后者跟着地址走才稳。
     */
    const triedClick = new Set<string>();
    /**
     * **结构同类**：把 selector 里的 `:nth-of-type(n)` 抹掉，剩下的就是这个控件在
     * DOM 里的形状。12 张商品卡片、一张表的 30 行、一个网格的每个格子——形状是同一个。
     */
    const shapeOf = (sel: string): string => sel.replace(/:nth-of-type\(\d+\)/g, "");
    /**
     * 形状试过、且**没换来新界面**的，它的结构同类就不用再试了。
     *
     * 不能一上来就按形状去重：导航栏里 `nav > a:nth-of-type(1)` 和 `(2)` 形状相同，
     * 却是「首页」和「关于」两个不同的页面——那样会把整块导航判成一个控件。
     * 所以是自适应的：**先试代表，代表没走出去，才跳过它的同类**。
     * 12 张商品卡片因此只花 1 轮而不是 12 轮；而两个导航链接谁也不挡谁。
     */
    const shapeDry = new Set<string>();
    /**
     * **看见过但还没走的地址。**
     *
     * 探索是深度优先的：在 `/#/login` 上同时看见了 `#/forgot-password` 和 `#/register`，
     * 按 DOM 顺序走了前一个，然后顺着走远，**再没回来** —— `#/register` 就此丢失。
     * 材料里明明记着这条链接，注册页却一次都没进过，而它是五次全漏里的一条。
     *
     * 所以另存一份全局队列：这一屏没东西可做时，先去队列里取一个没去过的地址，
     * 而不是直接退回上一屏。爬虫本来就是这么做的——边界是全局的，不是当前页的。
     */
    const frontier = new Set<string>();
    /**
     * **直接访问打不开的地址。**
     *
     * 单页应用的路由有三种形态，而它们对「直接访问这个地址」的答案完全相反：
     *
     *   哈希路由（Juice Shop）        `/#/login` 直接访问可以
     *   服务端渲染（PetClinic）        `/owners/find` 直接访问可以
     *   pushState 且服务端没兜底       `/user/signin` 直接访问是 **404**
     *
     * dimeshift 属于第三种：`/user/signin` 返回 `{"code":"ResourceNotFound"}`，
     * 而点那条链接会在当前页开一个**弹窗**（URL 不变，多出 5 个输入框）。于是
     * 「没去过的路由优先」这条策略在它身上是**有害的**——把浏览器带去 404，
     * 而真正的登录界面就在一次点击之外。
     *
     * 三种形态没法从页面上看出来，只能试：**goto 过去发现是死路，就把这个地址记下来，
     * 退回去改成点它。** 判据是「这一屏一个控件都没有」——一个正常界面不会没有控件，
     * 而 404 页、JSON 响应、空壳都没有。
     */
    const deadHref = new Set<string>();
    /**
     * 走出被测应用的**路段**，不只是那一个地址。
     *
     * 实测（demo.binance.com，2026-09-01）：期货页上挂着几百个 `/en/trade/<PAIR>` 链接，
     * 每一个点进去都会被弹到 `accounts.binance.com`。只记住"这个地址走出去过"，
     * 下一轮就去试下一个交易对——探索的 7 轮预算全花在同一件已经知道结果的事上，
     * 最后交出「2 屏 / 14 个地址看见了但一次都没进去」。
     *
     * 人不会这样：撞了两次就知道**整个 /en/trade/ 都是别处**。所以这里按父路径记，
     * 撞够 `OFFSITE_TOLERANCE` 次就把整段划掉。
     */
    const offsiteHits = new Map<string, number>();
    const OFFSITE_TOLERANCE = 2;
    /** `/en/trade/BTC_USDT` → `/en/trade`。只吃掉最后一段，别把整站折成 `/`。 */
    const sectionOf = (href: string): string => {
      const p = pathOf(href);
      const cut = p.replace(/\/+$/, "").lastIndexOf("/");
      return cut > 0 ? p.slice(0, cut) : p;
    };
    const offsiteSection = (href: string): boolean =>
      (offsiteHits.get(sectionOf(href)) ?? 0) >= OFFSITE_TOLERANCE;
    /** 下一轮要先回到哪张表单上接着做实验。见 `nextAction` 开头那段。 */
    let probeReturn: string | undefined;
    /**
     * 一个结构同类在同一条路由上最多点几次。
     *
     * `shapeDry` 只在代表**没走出去**时才拦——而 Juice Shop 的商品卡片每点一张都打开
     * 一个内容不同的弹窗，**每次都是新状态**，于是那条规则一次都不触发：35 轮里有 14 轮
     * （40% 的预算）花在 Banana、Basil、Berry、Bragă、Carrot……而登录之后的注册、联系、
     * 关于三页一个都没走到。
     *
     * 所以再加一道硬上限。三次的理由：一次看不出这一类控件是不是都长一样，
     * 三次足以看出，而十二次和三次给出的答案没有区别。
     *
     * **按路由计，不按状态计。**按状态计会被这个现象绕开——每点一张卡片都进了一个
     * 新状态，计数在新状态里又从零开始。这几个状态共享同一条路由 `/#/search`，
     * 而「这条路由上有一排长得一样的东西」才是要表达的事实。
     */
    const SHAPE_CAP = 3;
    const shapeCount = new Map<string, number>();
    /** 去过的地址。同一个地址走第二次对发现新界面没有任何帮助。 */
    const triedGoto = new Set<string>();
    /**
     * 页内广度优先已经切过的项：`路由::组::文案`。
     *
     * 按路由分键，是因为同一个组在不同页上是不同的东西；按文案而不是选择器，
     * 是因为交易类界面重渲染之后 `nth-of-type` 路径会变，而文案不变。
     */
    const triedInPage = new Set<string>();
    /**
     * 切过代表项之后既没换签名、也没产生差异的组——整组标死，不再试它剩下的选项。
     *
     * 这是 `shapeDry` 那条自适应规则（一次看不出、三次足以看出、十二次和三次
     * 答案一样）搬到"组"这个粒度上。
     */
    const dryGroups = new Set<string>();
    // 去重和状态 id 必须用**同一把尺子**量地址。此前这里另写了一个丢哈希的
    // `pathOf`，于是在哈希路由的单页应用上，访问过 `/#/search` 之后 `/#/basket`
    // 和 `/#/login` 全被判成「去过了」——探索在第一屏就停了，而图看起来是满的。
    let current = first;
    triedGoto.add(pathOf(first.url));
    /**
     * 被测应用的边界。**在到达时判，不能只在链接上判。**
     *
     * 「站外链接不点」这条规则看的是链接的 origin，而 Juice Shop 有个
     * `/redirect?to=<外部地址>` 端点——那个链接**本身是同源的**，规则判它内部完全正确，
     * 但它一跳就把浏览器带去了 github.com。到了那里，`location.origin` 也变成了
     * github.com，于是 GitHub 自己的每一条链接都成了"同源"：一次实测里 16 条路由有 6 条
     * 是 GitHub 的（`/features/copilot`、`/mcp`……），30 屏预算被吃掉五分之一，
     * 而这些屏和被测产品毫无关系。
     *
     * **同源的地址可以重定向到任何地方**，所以判据必须是「现在人在哪」，
     * 而不是「链接指向哪」。
     */
    const homeOrigin = (() => {
      try {
        return new URL(first.url).origin;
      } catch {
        return "";
      }
    })();
    let stoppedBecause = spec.deep === false ? "只采入口页（deep 关闭）" : "";
    let stopped: { kind: string; n?: number } | undefined =
      spec.deep === false ? { kind: "entryOnly" } : undefined;
    let dry = 0;
    let rounds = 0;
    /**
     * 连续失败单独计。
     *
     * 一次点不动说明的是「那条路走不通」，不是「这个产品看完了」——拿它去吃 dry 的预算，
     * 会因为一个点不动的控件就宣告探索结束。但它也不能白试到天荒地老，所以自己有个上限。
     */
    let consecutiveFailures = 0;
    note(`入口页：${first.text.length} 字，${first.controls.length} 个控件`);

    /**
     * 这一屏接下来做什么。
     *
     * 两种动作，分得很清楚：
     *   `goto` —— **同源链接不需要模型**。点一个 `<a>` 就是走到它的 href，这是查得出来的
     *             事实，不是需要判断的事。省下的不只是一次调用，还有它可能点错的那一次。
     *   `click` —— 按钮才需要模型：它做什么只有看着页面才知道。
     */
    type Step =
      | { key: string; kind: "login"; instruction: string }
      | {
          key: string;
          kind: "click";
          selector: string;
          label: string;
          shape: string;
          /** 页内广度优先时它属于哪个控件组。切完要记"这一组的这一项试过了"。 */
          group?: string;
          /** 这是 charter 里的一个目标。回执按它记，dry 计数对它豁免。 */
          charter?: { stableId: string; specId: string; featureId: string };
          /** charter 的 fill 目标要填的值（规则包声明）。 */
          fillValue?: string;
          /** charter 目标声明的容器文案（`match.within`）：点之前按它把元素重新找回来。 */
          within?: string[];
        }
      | { key: string; kind: "goto"; href: string }
      /**
       * **做实验**：故意把表单空着提交，看产品说什么。
       *
       * 遍历走不到校验状态——通往它们的边需要有人**故意**造一个坏输入。实测在 PetClinic 上，
       * 13 条黄金清单未覆盖的 7 条里有 5 条是这一类（必填校验、格式校验、搜不到的提示）。
       * 那不是「覆盖还不够高」，是黑盒遍历的**结构性缺口**。
       *
       * 这一步只做最保守的一种实验：**空着提交**。它不需要知道任何字段该填什么，
       * 而绝大多数表单对空提交都有话说。填坏值（电话填字母、日期填昨天）需要知道字段语义，
       * 那是下一步的事。
       */
      | { key: string; kind: "probe"; form: string; submit: string; label: string; variant: ProbeVariant; rest: number; via: "submit" | "enter" };
    /**
     * charter 模式下，通用遍历档也不许碰这些：命中 state-change 目标的（Place Order、
     * Cancel All）、命中禁点词表的。charter 已经对它们做了「blocked」这个决定，
     * 通用档绕过去点一下，就把探索变成了下单。
     */
    const charterForbids = (c: Control): boolean => {
      if (!spec.charter) return false;
      const here = pathOf(current.url);
      // 命中任何 charter 目标的控件都归 charter 档管：试过的不必再试，拦下的不许绕过。
      // 实测（2026-09-10）：通用档按自己的去重键把 Isolated 又点了一次，把已经切回 cross 的模式再切走。
      if (spec.charter.featureTargets.some((t) => matchTarget(c, t, here))) return true;
      return spec.charter.actionsPolicy.forbidLabels.some((re) => { try { return new RegExp(re, "i").test(c.label); } catch { return false; } });
    };
    const nextAction = (screen: { url: string; elements: Control[] }): Step | undefined => {
      const here = pathOf(screen.url);
      // 有密码框就先登录：凭证写在页面上（演示站的常见做法），那一句需要看着页面判断，
      // 是这条循环里**唯一**必须交给模型的一步。
      const loginKey = `${here}::__login__`;
      if (screen.elements.some((e) => e.display.startsWith("input[password]")) && !triedClick.has(loginKey))
        return {
          key: loginKey,
          kind: "login",
          // 环境配了登录步骤就照着做；没配才退回「用页面上写着的凭证」那种猜法。
          instruction: spec.login?.length
            ? spec.login.join("；然后")
            : "Log in using the test credentials shown on this page.",
        };
      /**
       * 抽屉/菜单开关最后再试。
       *
       * 导航抽屉是「离开这一屏」的方式，而它在 DOM 里往往排在最前面。实测里这一条让探索
       * 每到一个新页面就先开菜单、再点「All Items」退回列表——**抽屉把探索一次次拉回起点**，
       * 7 屏里有 3 屏只是「某页 + 菜单打开」。先把这一屏自己的东西走完，再看抽屉里有什么。
       */
      const drawer = /open\s*menu|close\s*menu|menu|导航|菜单|汉堡/i;
      const ordered = [
        ...screen.elements.filter((c) => !drawer.test(c.label)),
        ...screen.elements.filter((c) => drawer.test(c.label)),
      ];
      /**
       * 这一屏有表单就先做一次实验——空着提交。
       *
       * 排在点击之前：校验状态是这一屏最值得看的东西，而点走了就回不来了
       * （多数导航会离开这一页）。一个表单只做一次，做过就记下。
       */
      /**
       * **先回实验台。**
       *
       * 一个表单有三档实验，而第一档往往就把页面带走了：PetClinic 的 `Find Owner`
       * 空提交直接跳到 `/owners`，于是「填查不到的姓氏」这一档永远轮不到——而它正是
       * 五次全漏的 G-04。实验和点击不一样：点击是「往前走」，实验是「在同一张表单上
       * 换一种输入再看一次」，走了就得回来。
       *
       * 只在还有没做完的档时回，最多两次，不进 `triedGoto`（那张表就是要重复访问的）。
       */
      if (probeReturn) {
        const back = probeReturn;
        probeReturn = undefined;
        return { key: `__probeback__${back}`, kind: "goto", href: back };
      }

      /**
       * **charter 目标优先于一切遍历。**
       *
       * 这一档按规则包里目标的顺序（领域顺序）挑，不按 DOM 顺序；普通 button、
       * checkbox、自定义控件都行，不要求它在某个 ARIA 组里——原探索把 Isolated /
       * 10x / Reduce Only 这些普通按钮排在了路由之后，8 屏预算全花在离开交易页上。
       * 副作用等级为 state-change 的目标永远不会从这里出来，它们在 noteState 时已记 blocked。
       */
      if (tracker) {
        const pick = tracker.next(here, screen.elements);
        if (pick)
          return {
            key: `__charter__${pick.target.stableId}`,
            kind: "click",
            selector: pick.control.selector,
            label: pick.control.label,
            shape: `charter:${pick.spec.id}`,
            charter: { stableId: pick.target.stableId, specId: pick.spec.id, featureId: pick.spec.featureId },
            ...(pick.spec.match.within.length ? { within: pick.spec.match.within } : {}),
            // fill 目标：填这个声明好的值，而不是点它。值来自规则包，探索不自己编。
            ...(pick.spec.action === "fill" && pick.spec.value ? { fillValue: pick.spec.value } : {}),
          };
      }

      const submitBtn = screen.elements.find((e) => e.submit && e.form);
      if (submitBtn) {
        /**
         * 一个表单做三次实验，按等价类分：
         *
         *   empty      清空所有字段再提交         —— 必填校验
         *   malformed  给有格式的字段填非法值      —— 格式校验（电话填字母、密码太短）
         *   unmatched  填格式合法但查不到的值      —— 「搜不到」「凭证错误」这一类
         *
         * 此前只做 empty，理由是「唯一不需要知道字段语义就能做的实验」。两个应用各跑五次
         * 之后，**每次都漏的十条里有六条要后两类**（搜不存在的姓氏、电话填字母、
         * 邮箱留空、凭证错误、密码过短、搜索无匹配）。不需要语义的那一半已经拿到了，
         * 剩下的必须认字段——但认字段用不着模型，`type` 加上名字就够。
         *
         * `malformed` 只在这一屏真有带格式的字段时才做：纯文本框填什么都不算格式错，
         * 白做一轮，而干轮预算就是这样被吃掉的。
         */
        const hasFormatted = screen.elements.some(
          (e) => e.fillable && e.form === submitBtn.form && FORMATTED.includes(e.fieldKind),
        );
        const isLookup = LOOKUP_SUBMIT.test(submitBtn.label);
        for (const variant of ["empty", "malformed", "unmatched"] as const) {
          if (variant === "malformed" && !hasFormatted) continue;
          if (variant === "unmatched" && !isLookup) continue;
          const probeKey = `${here}::__probe__::${submitBtn.form}::${variant}`;
          if (triedClick.has(probeKey)) continue;
          const applicable = (["empty", "malformed", "unmatched"] as const).filter(
            (v) =>
              !(v === "malformed" && !hasFormatted) &&
              !(v === "unmatched" && !isLookup) &&
              !triedClick.has(`${here}::__probe__::${submitBtn.form}::${v}`),
          );
          return {
            key: probeKey,
            kind: "probe",
            form: submitBtn.form,
            submit: submitBtn.selector,
            label: submitBtn.label,
            variant,
            rest: applicable.length - 1,
            via: "submit",
          };
        }
      }

      /**
       * **页内控件组，广度优先。**
       *
       * 这一档是为「业务活在页内」的应用加的。合约交易页只有一条 route，
       * 整个产品是一组组 `role=tablist`：下单类型（Limit / Market / Conditional）、
       * 账户面板（Positions / Open Orders / Order History / …）、图表（Chart / Info）。
       * 实测这一页上有 4 个这样的组、16 个控件带得出选中态。
       *
       * 广度优先的三条边界，缺一就会爆炸或空转：
       * ① **组内挨个切**，切过的不再切（`triedInPage`）；
       * ② **组间不做笛卡尔积**——只走深度 1，切一组、记差异、再切下一组。
       *    Limit×全仓×杠杆×买卖是四维积（上百种），而人不会这么试；
       * ③ 一个组的代表切过之后签名与差异都为空，整组标死（`dryGroups`），不再试它剩下的。
       *
       * 还有一条不是效率而是安全：**永远不点提交类控件**。
       * 这一档只点 tab / switch / radio / checkbox / option / combobox——
       * 它们改的是"界面处于什么状态"，不是"把一笔订单发出去"。
       */
      const IN_PAGE_ROLES = new Set(["tab", "switch", "radio", "checkbox", "option", "menuitemradio", "menuitemcheckbox"]);
      /**
       * 场景计划决定**先点哪一组**。
       *
       * 计划里的控件编号是入口页那一次采集的下标，重渲染之后下标会漂——
       * 所以落到**组名 + 文案**上，那两样稳得多。P0 的故事排最前，
       * 计划里没提到的组排最后（但不排除：模型漏看的东西照样要探）。
       */
      const planned = new Map<string, number>();
      if (plan)
        for (const s of plan.stories) {
          const w = s.priority === "P0" ? 0 : s.priority === "P1" ? 1 : 2;
          for (const n of s.controls) {
            const e = first.elements[n];
            if (e) planned.set(`${e.group}::${e.label}`, Math.min(planned.get(`${e.group}::${e.label}`) ?? 9, w));
          }
        }
      const rank = (c: Control): number => planned.get(`${c.group}::${c.label}`) ?? 5;
      const inPageCandidates = ordered.filter(
        (c) =>
          !c.external &&
          !charterForbids(c) &&
          !!c.group &&
          IN_PAGE_ROLES.has(c.role) &&
          !c.selectedNow &&
          !OFF_LIMITS.test(c.display) &&
          !triedInPage.has(`${here}::${c.group}::${c.label}`) &&
          !dryGroups.has(`${here}::${c.group}`),
      );
      // 计划里的排前面；同一档保持原顺序（稳定排序），这样"没提到的"仍然按 DOM 顺序探。
      inPageCandidates.sort((a, b) => rank(a) - rank(b));
      /**
       * 要不要把这一档排在"未去过的路由"前面。
       *
       * `auto` 按事实判，不按猜测：这一屏有 ≥2 个控件组，就认为业务活在页内。
       * 判据必须是事实，因为下面那条"路由优先"的规则对多路由产品是**对的**——
       * 它是从「30 屏花在一个页内状态上、另一条路由一次没去」的实测里长出来的，
       * 翻死了会毁掉 PetClinic / Juice Shop 那两个基准。
       */
      const groupCount = new Set(screen.elements.filter((c) => c.group).map((c) => c.group)).size;
      const mode = spec.inPageFirst ?? "auto";
      const inPageWins = mode === "on" || (mode === "auto" && groupCount >= 2);
      if (inPageWins && inPageCandidates[0]) {
        const c = inPageCandidates[0];
        return {
          key: `__inpage__${c.group}::${c.label}`,
          kind: "click",
          label: c.label,
          selector: c.selector,
          // shape 是"同一形状的控件点过几次"的去重键；页内切换按组去重，所以借用组名。
          shape: `inpage:${c.group}`,
          group: c.group,
        };
      }

      /**
       * **没去过的路由，优先于同一路由上的新状态。**
       *
       * 探索现在是预算受限的（采满上限而停，不是没东西可点了）。预算怎么花就决定了
       * 覆盖到哪：Juice Shop 上一次把 30 屏花在 `/#/search` 的十几个页内状态上，
       * 而 `/#/register`、`/#/about` 一次都没去——它们在侧边栏里躺着，只是排在后面。
       *
       * 一条通往没见过的路由的链接，是**确定**能带来一个全新界面的动作；点一个同路由的
       * 控件是**可能**带来一个新状态。预算紧的时候先要确定的那个。这也正是基于 URL 的
       * 爬虫先扩边界再深入的道理。
       *
       * 只对 `href` 成立——点击的落点事先不知道，没法这样排序。
       *
       * 2026-09-01 加了一个前置条件：上面那一档。理由见那里——单 route 的产品上
       * 这条规则是反向的，它保证把有限预算优先花在**离开被测页**上。
       */
      const knownRoutes = new Set(sfgStates.map((st) => st.route));
      // 页内候选还没枯竭时，不要急着跳出这一页。
      if (inPageWins && inPageCandidates.length) {
        /* 上面已经 return 了，这里留空是为了让阅读顺序和优先级顺序一致 */
      }
      for (const c of ordered) {
        if (c.external || !c.clickable || OFF_LIMITS.test(c.display)) continue;
        if (!c.href || c.href === here || triedGoto.has(c.href) || NOT_A_SCREEN.test(c.href)) continue;
        if (offsiteSection(c.href)) continue;
        if (deadHref.has(c.href)) continue;
        if (knownRoutes.has(pathOf(new URL(c.href, screen.url).toString()))) continue;
        { const to = new URL(c.href, screen.url).toString(); if (!routeAllowed(spec.charter, entryRoute, pathOf(to), to)) continue; }
        return { key: c.href, kind: "goto", href: c.href };
      }

      /**
       * **没有 `<form>` 的输入框也要能做实验——回车就是它的提交。**
       *
       * Juice Shop 的搜索页整页 0 个 `<form>`：搜索框是一个光秃秃的 `<input>`，
       * 提交靠回车。而实验机制此前要求 `submit && form` 两个条件，于是搜索这一整块
       * 行为——「搜不到时说什么」——永远做不了实验。单页应用不用 `<form>` 是常态，
       * 这不是个别现象。
       *
       * 只对**查询类**输入框做（名字/占位符像搜索的那种），理由和 `LOOKUP_SUBMIT`
       * 那条一样：往一个新增表单里填值再回车，会真的写库。
       */
      if (!submitBtn) {
        /**
         * 哪个输入框算「查询框」：文案像搜索的，**或者**这一屏上只有它一个可填控件
         * 而且整屏没有表单。
         *
         * 后一条是为匿名输入框准备的——Juice Shop 的搜索框四样文案兜底全空，
         * 按名字永远认不出来。而「整屏没有 form、只有一个孤零零的输入框」这个形状
         * 本身就说明了它是干什么的：新增和编辑都会用表单，用不上表单的输入框
         * 基本只有搜索和筛选。
         */
        const fillables = screen.elements.filter((e) => e.fillable && !e.form);
        const box =
          fillables.find((e) => LOOKUP_SUBMIT.test(`${e.label} ${e.display}`)) ??
          /**
           * 兜底那一条**只对真正匿名的输入框成立**。
           *
           * 它当初是为 Juice Shop 的搜索框加的——那个框没有 aria-label、没有 placeholder、
           * 没有 id、没有 title，按名字永远认不出来，只能靠「整屏没有 form、只有一个
           * 孤零零的输入框」这个形状来认。
           *
           * 但形状认不出用途。dimeshift 的 `/plans` 上有一个叫 **Plan name** 的框，
           * 同样没有 form、同样只有一个——兜底规则把它当成查询框，填了个值回车，
           * **真的建了一条计划**。被测应用被改了，而基准的意义全在于它冻结不变。
           *
           * 有名字的框不走兜底：名字里没写「搜索」，就不该假设它是搜索。
           */
          (fillables.length === 1 &&
          !screen.elements.some((e) => e.form) &&
          fillables[0]!.width >= 60 &&
          fillables[0]!.label.startsWith("（无可见文案")
            ? fillables[0]
            : undefined);
        if (box) {
          for (const variant of ["empty", "unmatched"] as const) {
            /**
             * **按控件形状全局记，不按路由记。**
             *
             * 搜索框在工具栏里，每一条路由上都有——按路由记，它会在每一页各做两次实验。
             * 一次实测里这样打出 15 条实验，把 30 屏预算吃光，注册、关于、联系三页
             * 全部丢失，命中从 6/7 掉到 3/7。同一个控件在不同页面上做同一件事，
             * 做一次就够。
             */
            const k = `__boxprobe__::${shapeOf(box.selector)}::${variant}`;
            if (triedClick.has(k)) continue;
            const left = (["empty", "unmatched"] as const).filter(
              (v) => !triedClick.has(`__boxprobe__::${shapeOf(box.selector)}::${v}`),
            );
            return {
              key: k,
              kind: "probe",
              form: box.selector,
              submit: box.selector,
              label: box.label || "搜索框",
              variant,
              rest: left.length - 1,
              via: "enter",
            };
          }
        }
      }

      /**
       * 当前这一屏没有指向新路由的链接，就去**全局队列**里取一个。
       *
       * 队列装的是「在任何一屏上见过、但还没走过」的地址。`#/register` 就是死在这个
       * 差别上：它在登录页上被看见，探索从登录页走去了 forgot-password，
       * 而退回只能沿原路，那条链接再没被想起来。
       *
       * 位置很重要——**排在所有点击之前**。此前它放在最后（「这一屏彻底没事可做」才查），
       * 而探索是预算受限的：预算在「没事可做」之前就花完了，队列一次都没被查过。
       */
      for (const href of frontier) {
        frontier.delete(href);
        if (triedGoto.has(href) || NOT_A_SCREEN.test(href) || deadHref.has(href)) continue;
        if (offsiteSection(href)) continue;
        let route = "";
        try {
          route = pathOf(new URL(href, screen.url).toString());
        } catch {
          continue;
        }
        if (sfgStates.some((st) => st.route === route)) continue;
        if (!routeAllowed(spec.charter, entryRoute, route, new URL(href, screen.url).toString())) continue;
        return { key: href, kind: "goto", href };
      }

      for (const c of ordered) {
        // 外站不点：探索的对象是这个产品，不是它页脚链到的地方。
        if (c.external || !c.clickable || OFF_LIMITS.test(c.display)) continue;
        if (charterForbids(c)) continue;
        /**
         * 指向别处的链接直接走过去；**指向当前地址的不是「没地方去」，是 JS 驱动的链接**。
         *
         * SauceDemo 的商品链接全是 `href="#"`，解析出来等于当前地址。把它们当成
         * 「已经在这儿了」全部跳过，商品详情就一个都进不去——一个把整块功能判成
         * 「不用去」的规则，比没有规则更糟，因为它看起来是在正常工作。
         */
        // 直接访问打不开的地址不再 goto，但**也不跳过它**——落到下面的点击分支上，
        // 因为那才是这类单页应用打开它的方式。
        if (c.href && c.href !== here && !deadHref.has(c.href)) {
          if (triedGoto.has(c.href) || NOT_A_SCREEN.test(c.href)) continue;
          if (offsiteSection(c.href)) continue;
          { const to = new URL(c.href, screen.url).toString(); if (!routeAllowed(spec.charter, entryRoute, pathOf(to), to)) continue; }
          return { key: c.href, kind: "goto", href: c.href };
        }
        /**
         * 同一屏上**文案相同的控件是同一类控件，试一个就够**。
         *
         * Juice Shop 的搜索页有 12 个「Add to Basket」。它们指向不同商品，但对
         * 「这个产品有哪些界面」这个问题给出的答案完全一样——点完 12 次，还在同一屏。
         * 早先按 selector 记，于是这 12 次各算一个空轮，干轮预算在走到导航菜单之前
         * 就耗光了：探索停在 8 屏，登录、注册、联系一个都没看到。**冗余不只是浪费，
         * 它会把没探索的部分吃掉。**
         *
         * 按文案归一后的名字记（数字也归一，见 `numless` 的同一条理由：角标不是身份）。
         * 没有可见文案的控件退回按 selector 记——那时文案不是身份，位置才是。
         */
        const cls = c.label.startsWith("（无可见文案")
          ? c.selector
          : c.label.replace(/\d+/g, "#");
        const key = `${here}::${cls}`;
        if (triedClick.has(key)) continue;
        /**
         * **结构同类去重不适用于带 href 的元素。**
         *
         * 那两条规则（代表走不出去就跳过同类、同类每条路由最多三次）是为**重复的部件**
         * 设计的：12 张商品卡片、一张表的 30 行——它们长得一样，也做同一件事。
         * 当初我写下它们时就注意到导航栏是反例（`nav > a:nth-of-type(1)` 和 `(2)`
         * 形状相同却通向两个不同页面），当时的理由是「真正的导航链接走 goto 分支，
         * 不受影响」。
         *
         * dimeshift 把这个前提打掉了：它的 `/user/signin` 直接访问是 404，
         * 于是那些链接落到了**点击**分支上——而 `$ dimeshift` 和 `Home` 都指向 `/`、
         * 点了状态不变，`shapeDry` 就把整条导航栏判成了同一类。`Sign In`、`Register`
         * 从此再也不会被点，图坍缩到只剩首页一个状态。
         *
         * 修法回到那两条规则的本意：**href 不同就是去处不同**，那不是重复部件。
         */
        const shape = shapeOf(c.selector);
        if (!c.href) {
          if (shapeDry.has(`${currentId}::${shape}`)) continue;
          if ((shapeCount.get(`${here}::${shape}`) ?? 0) >= SHAPE_CAP) continue;
        }
        return { key, kind: "click", selector: c.selector, label: c.label, shape };
      }

      return undefined;
    };

    while (
      spec.deep !== false &&
      !token.cancelled &&
      screens.length < maxScreens &&
      dry < dryLimit &&
      consecutiveFailures < 3 &&
      rounds < maxRounds
    ) {
      rounds += 1;
      const next = nextAction(current);
      if (!next) {
        // 这一屏能点的都点过了。退回上一屏接着找——不退，探索会卡在最深的那一屏上。
        const page = session!.page as unknown as {
          goBack?: () => Promise<unknown>;
          goto: (u: string) => Promise<unknown>;
        };
        if (!page.goBack) {
          stoppedBecause = "这一屏能点的都点过了，而且退不回去";
          stopped = { kind: "noWayBack" };
          stopped = { kind: "noWayBack" };
          break;
        }
        note("这一屏能点的都点过了，退回上一屏");
        try {
          const before = signatureOf(current);
          await page.goBack();
          await settle("导航后");
          current = await snapshot(`回退后`);
          /**
           * 退回来落到一个 0 控件的页面上——那是死路（404、JSON、空壳），不是界面。
           * 不能给它建状态：一建，它就成了图里的一屏，还会被「看见但没走过」的链接
           * 指过去，让下游以为那里真有个界面。直接回入口重来。
           */
          if (!current.elements.length) {
            note(`退回来是一张空页面——回入口`, "warn");
            await page.goto(first.url);
            await settle("导航后");
            current = await snapshot("回入口");
          }
          /**
           * **退回之后 `currentId` 也要跟着变。**
           *
           * 第一版只更新了 `current`（下一步从哪一屏挑控件），没更新 `currentId`
           * （下一条边记成从哪个状态出发）。于是从 /oups 退回 /owners/find 之后，
           * 在 /owners/find 上点的「Find Owner」，被记成了发生在错误页上的点击——
           * 图里因此多出一条 `/oups --[点 Find Owner]--> /owners` 的边，
           * 而错误页上根本没有那个按钮。
           *
           * 后果不是「少了一条边」，是**图在说一件没发生过的事**：下游据此算出的最短路径
           * 会绕经错误页，产出的流程叫「经错误页触发主人列表加载」。看起来完整，全是错的。
           */
          currentId = idFor(current);
          noteLinks(current, currentId);
          /**
           * 退不动就停。
           *
           * 走到历史开头之后 `goBack()` 什么也不做，而这一轮又没试任何控件——于是它会
           * 一直「退」到预算烧光。实测一次 40 轮里有 32 轮就是这么没的。
           * 退了一步却回到同一屏，说明这条路已经走到头了。
           */
          if (signatureOf(current) === before) {
            stoppedBecause = "能点的都点过了，也退不动了";
            stopped = { kind: "exhausted" };
            break;
          }
          continue;
        } catch {
          stoppedBecause = "这一屏能点的都点过了，而且退不回去";
          stopped = { kind: "noWayBack" };
          stopped = { kind: "noWayBack" };
          break;
        }
      }
      /**
       * 动作之前的样子。**这是整条循环里此前一直缺的东西。**
       *
       * 在此之前，代码只问"这个签名见过没有"，从不比较前后——于是下游拿到的是 N 张
       * 完整屏幕转储，没有任何"点了 X 之后 Y 出现了"的因果标注，只能从整屏文字里抓字面。
       * 「验证入口页 Funding 数值」「验证入口页 Countdown 数值」就是这么来的。
       */
      const before = current;
      if (next.kind === "goto") triedGoto.add(next.href);
      else triedClick.add(next.key);
      // 页内切换按「路由::组::文案」记，同一项不再切第二次。选择器会随重渲染变，文案不会。
      if (next.kind === "click" && next.group)
        triedInPage.add(`${pathOf(current.url)}::${next.group}::${next.label}`);
      if (next.kind === "click" && next.charter) tracker!.markAttempted(next.charter.stableId);

      try {
        const page = session!.page as unknown as {
          goto: (u: string) => Promise<unknown>;
          goBack: () => Promise<unknown>;
          $eval: (sel: string, fn: (el: unknown, arg?: unknown) => unknown, arg?: unknown) => Promise<unknown>;
          evaluate: (fn: (arg: never) => unknown, arg?: unknown) => Promise<unknown>;
          press: (sel: string, key: string, opts?: { timeout?: number }) => Promise<unknown>;
          fill: (sel: string, value: string, opts?: { timeout?: number }) => Promise<unknown>;
        };
        if (next.kind === "goto") {
          note(`第 ${rounds} 轮：走到 ${next.href}`);
          await page.goto(new URL(next.href, current.url).toString());
        } else if (next.kind === "probe") {
          /**
           * 清空这个表单的所有可填字段，然后提交。
           *
           * 清空而不是随便填：**空提交是唯一不需要知道字段语义就能做的实验**，
           * 而它恰好触发绝大多数产品的必填校验——那正是遍历永远走不到的那类状态。
           */
          note(`第 ${rounds} 轮：${PROBE_WORDS[next.variant]}（${next.label}）`);
          if (next.via === "enter") {
            /**
             * 没有表单的输入框：填一个值，回车。这就是它的提交。
             *
             * 用 `fill` 而不是直接写 `.value`：Angular 的 ngModel 只认真正的聚焦 + 输入
             * 事件序列，手动赋值加派发 `input` 它照收不误，但**模型里的值不会变**——
             * 于是回车时组件拿到的还是空串，什么都不会发生。一次实测里搜索实验就是这样
             * 静悄悄地什么都没做。填表单那一支不受影响：那边是整表提交，走的是 DOM 值。
             */
            /**
             * **一定要给超时。**`fill` 会等元素变成可操作，而一个折叠到 4px、
             * 被别的层盖住、或者根本不可编辑的框永远等不到那一刻——一次实测里这一句
             * 把整次探索挂死了 28 分钟，没有任何错误。探索是有预算的，
             * 任何一步都不该能吃掉全部预算。
             */
            await page.fill(next.form, next.variant === "empty" ? "" : BAD_VALUES.text!.unmatched, {
              timeout: 4000,
            });
            await page.press(next.form, "Enter", { timeout: 4000 });
          } else {
          /**
           * 字段类别在页内重新判一次。
           *
           * 判定规则和采集那边是同一套（`type` 优先、再看名字），但不能把采集时的结论
           * 传进来——`page.$eval` 的函数体是**序列化到浏览器里执行**的，闭包变量带不过去。
           * 表反而可以：它是纯数据，随参数一起过去。
           */
          await page.$eval(
            next.form,
            (f: unknown, arg: unknown) => {
              const { variant, values } = arg as {
                variant: string;
                values: Record<string, { malformed: string; unmatched: string }>;
              };
              for (const el of (f as HTMLElement).querySelectorAll("input, textarea")) {
                const i = el as HTMLInputElement;
                const type = (i.type || "").toLowerCase();
                if (["submit", "button", "reset", "hidden", "checkbox", "radio", "file"].includes(type)) continue;
                let kind = "text";
                if (["email", "tel", "number", "password", "url", "date"].includes(type)) kind = type;
                else if (i.tagName.toLowerCase() !== "textarea") {
                  const hint = [i.name || "", i.id || "", i.placeholder || "", i.getAttribute("aria-label") || ""]
                    .join(" ")
                    .toLowerCase();
                  if (/mail/.test(hint)) kind = "email";
                  else if (/phone|tel(?!e?metry)|mobile|电话|手机/.test(hint)) kind = "tel";
                  else if (/pass|密码/.test(hint)) kind = "password";
                  else if (/\burl\b|website|homepage|网址/.test(hint)) kind = "url";
                  else if (/date|birth|日期|生日/.test(hint)) kind = "date";
                  else if (/\bnum|qty|quantity|amount|zip|postal|数量|金额|邮编/.test(hint)) kind = "number";
                }
                const row = values[kind] ?? values.text;
                // 格式非法这一轮只碰有格式的字段：纯文本框填什么都不算格式错，
                // 动了它反而会把「哪个字段引发了这条消息」搅浑。
                const v = variant === "empty" ? "" : variant === "malformed" ? row.malformed : row.unmatched;
                if (variant === "malformed" && !v) continue;
                i.value = v;
                i.dispatchEvent(new Event("input", { bubbles: true }));
                i.dispatchEvent(new Event("change", { bubbles: true }));
                // Angular / Vue 的表单校验挂在 blur 上——不派发它，填了也不显示错误。
                i.dispatchEvent(new Event("blur", { bubbles: true }));
              }
            },
            { variant: next.variant, values: BAD_VALUES },
          );
          await page.$eval(next.submit, (el) => (el as HTMLElement).click());
          }
        } else if (next.kind === "click") {
          /**
           * **按选择器点，不问模型。**
           *
           * 这个元素是我们自己刚采下来的，选择器也是自己生成的。把它翻译成
           * 「Click "shopping-cart-link"」再让一个看截图的模型去屏幕上找回来，是纯损失：
           * `data-test` 这种名字屏幕上根本不显示，模型找不到，而且**不报错，只是什么都不做**
           * ——一次实测里连着四轮都是这样，每一轮都被记成「没有新界面」。
           */
          if (next.fillValue !== undefined) {
            /**
             * 填一个**规则包声明过的**值。
             *
             * 为什么非要有这一步：2026-09-12 实测，会话签完之后 `Place Order` 出现了，
             * 点它什么都没发生——Size 是空的。提交这个功能差的不是权限，是一个值。
             * 用页内赋值 + input 事件，和点击那条路同一个理由：受控组件只认事件，不认键盘。
             */
            note(`第 ${rounds} 轮：往 ${next.label} 填 ${next.fillValue}（${next.selector}）`);
            /**
             * **填之前也要先把这个框找回来**——和点击那条路同一个理由，我先只改了点击。
             *
             * 2026-09-12 实测：链已经连成一段（填量紧挨着下单），填那一下的 effect 却是空的，
             * 屏幕上是 `Est: 0%`；上一次填成功时会多出 `Est: 60.0000%`。原因是这个框的
             * nth-of-type 路径在二十多轮重渲染之后指到了别处，值写进了看不见的地方，
             * 然后产品拒单：`Order could not match against any resting orders`。
             * 输入框的「文案」按采集时那套兜底认：aria-label / placeholder / 旁边的短标签 / name。
             */
            const filled = (await page.evaluate(((({ sel, label, v }: { sel: string; label: string; v: string }) => {
              const named: HTMLElement[] = [];
              const all = document.querySelectorAll("input,textarea");
              for (let i = 0; i < all.length; i++) {
                const el = all[i] as HTMLInputElement;
                if (!el.offsetWidth || !el.offsetHeight || el.disabled) continue;
                let name = (el.getAttribute("aria-label") || el.placeholder || "").trim();
                if (!name) {
                  const prev = (el.previousElementSibling as HTMLElement | null);
                  const t = (prev?.innerText || "").trim();
                  if (t && t.length <= 24) name = t;
                }
                if (!name) {
                  const first = el.parentElement ? (el.parentElement.firstElementChild as HTMLElement | null) : null;
                  const t = first && first !== el ? (first.innerText || "").trim() : "";
                  if (t && t.length <= 24) name = t;
                }
                if (!name) name = el.getAttribute("name") || "";
                if (name.slice(0, 60) === label) named.push(el);
              }
              const at = document.querySelector(sel) as HTMLInputElement | null;
              const target = at && named.indexOf(at) >= 0 ? at : named.length === 1 ? (named[0] as HTMLInputElement) : null;
              if (!target) return `ambiguous:${named.length}`;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
              if (setter) setter.call(target, String(v)); else target.value = String(v);
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              return target === at ? "selector" : "relocated";
            }) as unknown) as (arg: never) => unknown, { sel: next.selector, label: next.label, v: next.fillValue })) as string;
            if (filled !== "selector") note(`第 ${rounds} 轮：${next.label} 这个框的路径已经过时（${filled}）`);
            if (filled.startsWith("ambiguous")) {
              if (next.charter && tracker)
                tracker.record({
                  targetId: next.charter.stableId, targetSpecId: next.charter.specId, featureId: next.charter.featureId,
                  status: "blocked", stateBefore: currentId, reason: `field_${filled}`, round: rounds,
                  controlsAfter: [], evidenceRefs: [`sfg:state:${currentId}`],
                });
              continue;
            }
          } else {
          note(`第 ${rounds} 轮：点 ${next.label}（${next.selector}）`);
          /**
           * **页内 DOM 点击，不是真实鼠标点击。**
           *
           * 实测：`page.click`（真实鼠标）点 SauceDemo 的商品链接**不换屏**，而页内
           * `el.click()` 换。这类链接靠 JS 处理，真实鼠标的落点到不了它的处理器上。
           * 探索要的是覆盖，不是交互保真——保真是执行用例那一层的事。
           */
          /**
           * **点之前先核对这条路径还是不是那个控件。**
           *
           * 2026-09-12 实测：确认弹窗里的 `Buy / Long` 采集时路径是
           * `body div:nth-of-type(1) > … > button:nth-of-type(1)`；等轮到点它，
           * 交易页已经重渲染过，同一条路径上坐着的是上一个弹窗的按钮。回执上是
           * 「T-CONFIRM-ACT attempted」，而历史委托里一条单都没有——**点了，点错了，
           * 还记成点对了**。`stableId` 早就不用 nth-of-type（文案不会漂），
           * 真正点下去的那一下却还在用采集那一刻的路径。
           *
           * 所以：路径上的控件文案对不上，就按文案（以及 charter 声明的容器）重新找。
           * 找不到唯一的一个就不点——宁可这一轮空过，也不要一次点错被记成点对。
           */
          const clicked = (await page.evaluate(((({ sel, label, within }: { sel: string; label: string; within?: string[] }) => {
            /**
             * 这段在浏览器里跑，**不能出现具名函数**：tsx 会给 `const f = () => {}` 套一层
             * `__name(...)`，那个辅助在页面里不存在，搬进去就是 `__name is not defined`——
             * 2026-09-12 实测，整轮探索第 3 轮就 stuck，三个目标全记成 failed。所以下面全是循环。
             */
            const at = document.querySelector(sel);
            if (at && ((at as HTMLElement).innerText || (at as HTMLInputElement).value || at.getAttribute("aria-label") || "")
              .replace(/\s+/g, " ").trim() === label) { (at as HTMLElement).click(); return "selector"; }
            const hits: HTMLElement[] = [];
            const els = document.querySelectorAll("button,a,div,span,input,label");
            for (let i = 0; i < els.length; i++) {
              const e = els[i] as HTMLElement;
              const t = (e.innerText || (e as HTMLInputElement).value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
              if (t !== label || !e.offsetWidth || !e.offsetHeight) continue;
              if (within && within.length) {
                let container = "";
                for (let n: HTMLElement | null = e, k = 0; n && k < 12; k++, n = n.parentElement) {
                  const role = n.getAttribute ? n.getAttribute("role") || "" : "";
                  const cls = typeof n.className === "string" ? n.className : "";
                  const st = getComputedStyle(n);
                  const floats = (st.position === "fixed" || st.position === "absolute")
                    && (parseInt(st.zIndex || "0", 10) || 0) >= 10 && n.offsetWidth >= 200 && n.offsetHeight >= 100;
                  if (role === "dialog" || role === "alertdialog" || (n.getAttribute && n.getAttribute("aria-modal") === "true") ||
                      /modal|dialog|popup|drawer|overlay/i.test(cls) || floats) {
                    container = (n.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
                    break;
                  }
                }
                let ok = false;
                for (let j = 0; j < within.length; j++) {
                  try { if (new RegExp(within[j]!, "i").test(container)) { ok = true; break; } } catch { /* 坏正则当不匹配 */ }
                }
                if (!ok) continue;
              }
              hits.push(e);
            }
            /**
             * 同一句文案常常同时命中按钮和它里面的 span——那不是歧义，是一个控件的两层。
             * 先只留最里层（剔掉「包着另一个命中项」的那些），再优先按钮类。
             */
            const inner: HTMLElement[] = [];
            for (let i = 0; i < hits.length; i++) {
              let wraps = false;
              for (let j = 0; j < hits.length; j++) if (i !== j && hits[i]!.contains(hits[j]!)) { wraps = true; break; }
              if (!wraps) inner.push(hits[i]!);
            }
            let pick = inner;
            if (pick.length > 1) {
              const buttons: HTMLElement[] = [];
              for (let i = 0; i < pick.length; i++) {
                const el = pick[i]!;
                const r = el.getAttribute ? el.getAttribute("role") || "" : "";
                if (el.tagName === "BUTTON" || el.tagName === "A" || r === "button") buttons.push(el);
              }
              if (buttons.length === 1) pick = buttons;
            }
            if (pick.length !== 1) return `ambiguous:${pick.length}`;
            pick[0]!.click();
            return "relocated";
          }) as unknown) as (arg: never) => unknown, { sel: next.selector, label: next.label, within: next.within })) as string;
          if (clicked !== "selector") note(`第 ${rounds} 轮：${next.label} 的路径已经过时（${clicked}）`);
          if (clicked.startsWith("ambiguous")) {
            // 没点成要如实记：留空的话回执上是 `found_not_activated`，读起来像「预算没到」。
            if (next.charter && tracker)
              tracker.record({
                targetId: next.charter.stableId, targetSpecId: next.charter.specId, featureId: next.charter.featureId,
                status: "blocked", stateBefore: currentId, reason: `control_${clicked}`, round: rounds,
                controlsAfter: [], evidenceRefs: [`sfg:state:${currentId}`],
              });
            continue;
          }
          }
        } else {
          // 日志里留模板，明文永不落盘——和执行用例同一条规矩。
          note(`第 ${rounds} 轮：${next.instruction}`);
          const resolved = spec.resolve ? resolveText(next.instruction, spec.resolve) : next.instruction;
          await withModel(() => session!.agent.aiAction(resolved));
        }
        await settle("导航后");
        emit({ type: "navigated", shotRef: await shot(session) });

        const cameFrom = currentId;
        if (next.kind === "click") {
          const ck = `${pathOf(current.url)}::${next.shape}`;
          shapeCount.set(ck, (shapeCount.get(ck) ?? 0) + 1);
        }
        const probeOrigin = next.kind === "probe" && next.rest > 0 ? current.url : undefined;
        const after = await snapshot(`第 ${screens.length + 1} 屏`);
        const nowOrigin = (() => {
          try {
            return new URL(after.url).origin;
          } catch {
            return homeOrigin;
          }
        })();
        if (homeOrigin && nowOrigin !== homeOrigin) {
          // 这一屏不算数：它不属于被测产品。退回入口，接着走产品自己的东西。
          if (next.kind === "goto") {
            const sec = sectionOf(next.href);
            const n = (offsiteHits.get(sec) ?? 0) + 1;
            offsiteHits.set(sec, n);
            if (n === OFFSITE_TOLERANCE)
              note(`${sec}/ 这一段连着 ${n} 次都走出了被测应用——整段跳过，不再一个一个试`, "warn");
          }
          note(`跟着 ${next.kind === "goto" ? next.href : "一次点击"} 走出了被测应用（到了 ${nowOrigin}）——退回入口`, "warn");
          await page.goto(first.url);
          await settle("导航后");
          current = await snapshot("退回入口");
          currentId = idFor(current);
          continue;
        }
        /**
         * **一个控件都没有的屏是死路，不是界面。**
         *
         * 直接访问 dimeshift 的 `/user/signin` 得到的是 `{"code":"ResourceNotFound"}`
         * ——它进了图，成了一个 0 控件的状态，还挤掉了一屏预算，而真正的登录界面
         * 在一次点击之外。404 页、JSON 响应、空壳都没有控件；正常界面不会没有。
         *
         * 所以：不记这一屏，把这个地址记进 `deadHref`（下次改成点它），退回原处。
         */
        if (next.kind === "goto" && !after.elements.length) {
          deadHref.add(next.href);
          triedGoto.delete(next.href);
          note(`${next.href} 直接访问打不开（一个控件都没有）——改成点它`, "warn");
          // 用 goBack 而不是 goto 回去：goto 会把死页面留在历史里，
          // 后面探索退不动时 `goBack()` 正好退回它，`idFor` 又给它建一个 0 控件的状态。
          await page.goBack().catch(() => page.goto(current.url));
          await settle("导航后");
          current = await snapshot("退回");
          currentId = idFor(current);
          continue;
        }
        const sig = signatureOf(after);
        const wasNew = !seen.has(sig);
        const toId = idFor(after);
        /**
         * 这一步**做成了什么**。整条循环里此前没有任何一处比较前后。
         *
         * 文本差过掩码：行情每秒都在跳，那不算"做成了什么"。而控件的出现/消失、
         * 某个控件从未选变成选中，才是。
         */
        const effect = diffScreens(before, after);
        sfgEdges.push({
          from: currentId,
          to: toId,
          ...(effect.changed
            ? {
                effect: {
                  controlsAdded: effect.controlsAdded,
                  controlsRemoved: effect.controlsRemoved,
                  stateChanged: effect.stateChanged,
                  textAdded: effect.textAdded.slice(0, 12),
                },
              }
            : {}),
          action:
            next.kind === "goto"
              ? { kind: "goto", target: next.href, selector: "" }
              : next.kind === "login"
                ? { kind: "login", target: "登录表单", selector: "", input: "${env.*} / ${secret.*}" }
                : next.kind === "probe"
                  ? { kind: "probe", target: `${next.label}（${PROBE_WORDS[next.variant]}）`, selector: next.submit, input: "" }
                  : { kind: "click", target: next.label, selector: next.selector },
          ok: true,
          walked: true,
          /**
           * 「回到已知状态」和「状态没变」是两件事，标错了下游会以为什么都没发生。
           *
           * 前者是一条**真实的转移**（`/cart` 点 Continue Shopping 回到 `/inventory`），
           * 算结构覆盖率时要计入；后者才是原地不动。判据是 from 与 to 相不相等，
           * 不是「目标见过没见过」——我第一版写的就是后者。
           */
          ...(wasNew
            ? {}
            : currentId === toId
              ? { note: "状态未变" }
              : { note: "回到已知状态" }),
        });
        if (next.kind === "click" && next.charter) {
          const shotPath = await charterShot();
          tracker!.record({
            targetId: next.charter.stableId,
            targetSpecId: next.charter.specId,
            featureId: next.charter.featureId,
            status: "attempted",
            stateBefore: cameFrom,
            stateAfter: toId,
            action: { kind: "click", target: next.label, selector: next.selector },
            ...(effect.changed
              ? { effect: { controlsAdded: effect.controlsAdded, controlsRemoved: effect.controlsRemoved, stateChanged: effect.stateChanged, textAdded: effect.textAdded.slice(0, 12) } }
              : { reason: "no_effect" }),
            controlsAfter: after.controls,
            evidenceRefs: [`sfg:edge:${sfgEdges.length - 1}`, `sfg:state:${toId}`, ...(shotPath ? [`shot:${shotPath}`] : [])],
            round: rounds,
          });
          note(`charter 目标 ${next.charter.specId}：${effect.changed ? `有效果（+${effect.controlsAdded.length} 控件，${effect.stateChanged.length} 处状态变化）` : "没有变化——也记入回执"}`);
        }
        currentId = toId;
        current = after;
        if (tracker) {
          const found = tracker.noteState(toId, pathOf(after.url), after.elements, rounds);
          if (found.length) note(`这一屏新命中 ${found.length} 个 charter 目标：${found.map((t) => t.targetSpecId).join("，")}`);
        }
        // 实验把页面带走了，而这张表单还有没做完的档——下一轮先回去。
        if (probeOrigin && pathOf(after.url) !== pathOf(probeOrigin)) probeReturn = probeOrigin;
        if (seen.has(sig)) {
          /**
           * **实验的结果一定要进材料，哪怕它不算一个新状态。**
           *
           * 状态抽象是按**控件**算的，而校验消息只是**文字**——填一个字母进电话框、
           * 提交、页面多出一行 `numeric value out of bounds`，控件集合一个字没变。
           * 于是这一屏被判成「见过了」，它的文字连同那条消息一起被丢掉：实验做了，
           * 结果没留下。实测里 `Add Owner（填格式非法的值提交）` 就是这样白做的，
           * 材料里搜不到填进去的 `abcdef`，也搜不到应有的错误消息。
           *
           * 「这算不算一个新状态」和「这次观察值不值得留」是两个问题。遍历问前者，
           * 实验问后者——实验本来就是冲着那些看不出结构差别的行为去的。
           */
          if (next.kind === "probe") {
            screens.push(`（实验：${PROBE_WORDS[next.variant]} ${next.label}）\n${after.text}`);
            snapshotPartial();
            note(`实验结果记入材料（状态未变，但页面文字变了）`);
          }
          /**
           * 页内切换即使签名没换，只要**确实变了**就记进材料——但记的是**差异**，
           * 不是又一张整屏转储。
           *
           * 这是 probe 那条口子的同一个道理：「这算不算一个新状态」和「这次观察值不值得留」
           * 是两个问题。而记差异不记整屏，是因为整屏里全是行情数字，
           * 下游只会又抓一遍 Funding 和 Countdown。
           */
          if (next.kind === "click" && next.group && effect.changed) {
            screens.push(describeEffect(next.label, next.group, effect));
            snapshotPartial();
            note(`页内切换有效果，记入材料（签名未变）`);
          }
          // 代表没走出去 → 它的结构同类一并跳过。这一条直接把「12 张商品卡片吃掉
          // 11 个干轮」变成 1 个。
          if (next.kind === "click") shapeDry.add(`${cameFrom}::${next.shape}`);
          /**
           * 页内组：切了它的一个代表，签名没变、页面文字也没变 → **整组标死**。
           *
           * 只在两样都没变时才标死。只看签名不够——有些切换换的是数据不是结构
           * （切到 Order History 面板，控件一样、内容全变），那不该被当成"这一组没用"。
           */
          if (next.kind === "click" && next.group && !effect.changed)
            dryGroups.add(`${pathOf(current.url)}::${next.group}`);
          // charter 目标是计划内的工作，不是原地打转：它没换来新界面也不吃 dry 预算，
          // 否则三个不换屏的开关就能把一次探索提前结束。
          if (next.kind === "click" && next.charter) continue;
          // 原地打转也要记一笔：它是「这个产品就这么大」和「探索走不动了」之间的区别。
          dry += 1;
          note(`没有新界面（连续 ${dry}/${dryLimit} 次）`, "warn");
          continue;
        }
        seen.add(sig);
        noteLinks(after, toId);
        triedGoto.add(pathOf(after.url));
        visited.push(after.url);
        screens.push(after.text);
        snapshotPartial();
        dry = 0;
        consecutiveFailures = 0;
        note(`第 ${screens.length} 屏：${after.url}，${after.controls.length} 个控件`);
      } catch (e) {
        // 走不进去本身就是观察结果的一部分：下游会把它记成「没看到的」。
        const why = (e as Error).message.split("\n")[0].slice(0, 160);
        note(`没能往前走：${why.slice(0, 70)}`, "warn");
        const what =
          next.kind === "goto"
            ? `走到 ${next.href}`
            : next.kind === "click"
              ? `点 ${next.label}`
              : next.kind === "probe"
                ? `${PROBE_WORDS[next.variant]} ${next.label}`
                : next.instruction;
        missed.push(`${what} —— ${why}`);
        if (next.kind === "click" && next.charter)
          tracker!.record({ targetId: next.charter.stableId, targetSpecId: next.charter.specId, featureId: next.charter.featureId, status: "failed", stateBefore: currentId, action: { kind: "click", target: next.label, selector: next.selector }, controlsAfter: [], evidenceRefs: [`sfg:edge:${sfgEdges.length}`], reason: why, round: rounds });
        // 走不通也是一条边：它记的是「这条路走不过去」，而那正是下游「没有答案的地方」
        // 的来源之一。丢掉它，材料就只剩成功路径，看起来像这个产品没有走不通的地方。
        sfgEdges.push({
          from: currentId,
          action:
            next.kind === "goto"
              ? { kind: "goto", target: next.href, selector: "" }
              : next.kind === "login"
                ? { kind: "login", target: "登录表单", selector: "" }
                : next.kind === "probe"
                  ? { kind: "probe", target: `${next.label}（${PROBE_WORDS[next.variant]}）`, selector: next.submit, input: "" }
                  : { kind: "click", target: next.label, selector: next.selector },
          ok: false,
          walked: true,
          note: why,
        });
        consecutiveFailures += 1;
      }
    }
    if (!stoppedBecause) {
      stopped = token.cancelled
        ? { kind: "cancelled" }
        : screens.length >= maxScreens
          ? { kind: "screenCap", n: maxScreens }
          : rounds >= maxRounds
            ? { kind: "actionBudget", n: maxRounds }
            : consecutiveFailures >= 3
              ? { kind: "stuck" }
              : { kind: "dry", n: dryLimit };
      stoppedBecause = token.cancelled
        ? "被取消"
        : screens.length >= maxScreens
          ? `采满 ${maxScreens} 屏的上限`
          : rounds >= maxRounds
            ? `用完 ${maxRounds} 次动作预算`
            : consecutiveFailures >= 3
              ? "连续 3 次点不动"
              : `连续 ${dryLimit} 轮没有发现新界面`;
    }
    note(`探索结束：${screens.length} 屏 / ${rounds} 轮，${stoppedBecause}`);

    /**
     * 走到过什么、以及**没走到什么**，一起交出去。
     *
     * 后半句是这份材料唯一能自证薄不薄的地方：`spec.compose` 被要求把材料没说的记进
     * 「没有答案的地方」，而它只有在材料自己说了「这里我没看到」的时候才做得到。
     */
    /**
     * 把「看见但没走过」的链接补成边。
     *
     * 只在目标路由确实是我们到过的某个状态时才补——补一条指向未知地方的边，等于凭空
     * 声称那里有一屏。标 `walked: false`：**确认了链接存在，没有确认它真的跳到那里**。
     */
    const byRoute = new Map<string, string>();
    for (const st of sfgStates) if (!byRoute.has(st.route)) byRoute.set(st.route, st.id);
    const already = new Set(sfgEdges.map((e) => `${e.from}->${e.to ?? ""}`));
    let inferred = 0;
    for (const [from, hrefs] of linksSeen)
      for (const href of hrefs) {
        const to = byRoute.get(href.split("?")[0]);
        if (!to || to === from || already.has(`${from}->${to}`)) continue;
        already.add(`${from}->${to}`);
        inferred += 1;
        sfgEdges.push({
          from,
          to,
          action: { kind: "goto", target: href, selector: "" },
          ok: true,
          walked: false,
        });
      }
    if (inferred) note(`补上 ${inferred} 条看见但没走过的链接`);

    /**
     * 剩下的那些——看见了、而那个地址**从来没变成一个状态**——单独收成一份清单。
     *
     * 它们进不了图（补一条指向未知地方的边等于凭空声称那里有一屏），但丢掉它们，
     * 「这个产品有这个入口，我们一次都没进去」这句话就没人说得出来了。
     */
    const unvisited = [
      ...new Set(
        [...linksSeen.values()]
          .flatMap((set) => [...set])
          .filter((href) => !byRoute.has(href.split("?")[0]) && !NOT_A_SCREEN.test(href)),
      ),
    ].sort();
    if (unvisited.length) note(`${unvisited.length} 个地址看见了但一次都没进去`);

    const graph: StateFlowGraph = {
      // 记**实际生效**的那把尺子。此前这里写 "route+controls"，而挑函数时回落到的是
      // "route+controls/norm"——两个回落值不一致，图从第一天起就在说谎。
      abstraction: abstractionNameOf(abstractionName),
      /**
       * 这次探索走的是什么计划。
       *
       * 记它的理由和记抽象名字是同一条：一次说不出自己用了哪把尺子、按什么计划走的探索，
       * 没法和另一次比较。而"问过业务"和"没问过"是本轮改造要证明有效的那个变量。
       */
      plan: plan
        ? { asked: true, business: plan.business, stories: plan.stories.map((s) => ({ id: s.id, title: s.title, priority: s.priority })) }
        : { asked: false, business: "", stories: [] },
      // 见 sfg.ts 的 `collector`：采集规则变了，同一个抽象公式算出来的签名也就变了。
      // v3（2026-09-10）：输入框从包裹它的 <label> 取文案。见 snapshot 里 labelText 那段。
      collector: "aria-roles/v3",
      entry: sfgStates[0]?.id ?? "",
      states: sfgStates,
      transitions: sfgEdges,
      stoppedBecause,
      stopped,
      unvisited,
    };

    const report = tracker?.report(graph, stopped ?? { kind: "unknown" }, { maxScreens, screens: screens.length, rounds, maxRounds });
    if (report) note(`charter 回执：${report.completion}，目标 ${report.coverage.targetsPlanned}：已试 ${report.coverage.targetsAttempted} / 仅看见 ${report.coverage.targetsObservedOnly} / 阻塞 ${report.coverage.targetsBlocked} / 未找到 ${report.coverage.targetsNotFound}`);

    const coverage = [
      "===== 这次探索走到哪为止 =====",
      `采到 ${screens.length} 屏（上限 ${maxScreens}），走了 ${rounds} 轮，停止原因：${stoppedBecause}`,
      `走过的地址：${visited.join(" , ")}`,
      ...(missed.length ? ["没能走进去的地方：", ...missed.map((m) => `- ${m}`)] : []),
      "这份材料只覆盖上面列出的界面。没有出现在这里的功能，是没有被看到，不是不存在。",
    ].join("\n");

    /**
     * 收尾这几步是**同步的**，而 runner 的心跳阈值是 1 秒 × 3 次。
     * 2026-09-12 实测：探索打完回执 3 秒后 runner 被 SIGKILL（`no heartbeat for 3097ms`），
     * 整次运行连回执都没写出来——探索全跑完了，材料全丢了。所以这里逐段计时，
     * 哪一段在逼近那三秒，日志上看得见。
     */
    const t0 = Date.now();
    const summary = report ? `${describeGraph(graph)}\n\n${describeReport(report)}` : describeGraph(graph);
    const t1 = Date.now();
    const notes = budgeted(screens, summary, coverage);
    const t2 = Date.now();
    const shotRef = await shot(session);
    note(`收尾用时：回执摘要 ${t1 - t0}ms / 材料 ${t2 - t1}ms / 截图 ${Date.now() - t2}ms`);

    // 跑完了就把半成品删掉：留着它，下一次失败会捡到上一次的材料，而那比没有更糟。
    try { rmSync(partialPath, { force: true }); } catch { /* 删不掉就算了，里面带着时间戳 */ }

    return {
      // 图的摘要跟着材料一起走：下游整理规格时**先看结构再看正文**——
      // 实证研究的结论是「精简的功能级上下文」对 LLM 最有效，原始屏幕转储不是。
      notes,
      url: spec.url,
      log,
      shotRef,
      screens: screens.length,
      stoppedBecause,
      stopped,
      graph,
      ...(report ? { report } : {}),
    };
  } finally {
    await session?.cleanup();
  }
}

export async function runExplore(
  spec: ExploreSpec,
  emit: Emit,
  token: CancelToken = { cancelled: false },
): Promise<ExploreResult> {
  const shot = shooter(spec);
  const log: string[] = [];
  const note = (message: string, kind: "info" | "warn" = "info") => {
    log.push(message);
    emit({ type: "log", message, kind });
  };
  let session: Session | undefined;
  // The page keeps changing while a single aiQuery runs for tens of seconds; without this
  // the UI would show one frozen frame and look hung.
  let beat: ReturnType<typeof setInterval> | undefined;
  const startBeat = () => {
    stopBeat();
    beat = setInterval(async () => {
      if (token.cancelled) return;
      const shotRef = await shot(session);
      if (shotRef && !token.cancelled) emit({ type: "navigated", shotRef });
    }, 4000);
  };
  const stopBeat = () => {
    if (beat) clearInterval(beat);
    beat = undefined;
  };

  try {
    emit({ type: "start", url: spec.url });
    session = await launchSession(spec.url, spec.launch);
    emit({ type: "navigated", shotRef: await shot(session) });
    // 同样等页面安定，不是等一个固定的秒数——这条路上读空了页面，
    // 下游看到的是一份"这个产品什么都没有"的材料。
    await settleOn(session.page as unknown as { evaluate<T>(fn: () => T): Promise<T> }, {
      minMs: spec.settleMs ?? 600,
      maxMs: spec.maxSettleMs ?? 12_000,
    });

    startBeat();
    const flows = asArray(await withModel(() => session!.agent.aiQuery(spec.prompt)));
    stopBeat();
    if (token.cancelled) return { flows: [], log };
    note(`entry page → ${flows.length} flows`);
    emit({ type: "flows", flows });

    if (spec.deepPrompt) {
      try {
        note("Advancing one screen (deep crawl)…");
        await withModel(() =>
          session!.agent.aiAction(
            "If a login form is present, log in using any test/demo credentials shown on " +
              "this page; otherwise click the primary button to enter the application.",
          ),
        );
        await new Promise((r) => setTimeout(r, 1500));
        emit({ type: "navigated", shotRef: await shot(session) });
        startBeat();
        const deeper = asArray(await withModel(() => session!.agent.aiQuery(spec.deepPrompt!)));
        stopBeat();
        flows.push(...deeper);
        note(`advanced one screen → ${deeper.length} more flows`);
        emit({ type: "flows", flows: deeper });
      } catch (e) {
        stopBeat();
        note(`deep crawl skipped: ${(e as Error).message.slice(0, 70)}`, "warn");
      }
    }
    return { flows, log, shotRef: await shot(session) };
  } finally {
    stopBeat();
    await session?.cleanup();
  }
}

export async function runDebug(
  spec: DebugSpec,
  emit: Emit,
  token: CancelToken = { cancelled: false },
): Promise<void> {
  const shot = shooter(spec);
  const ctx = spec.resolve;
  const secretVals = Object.values(ctx.secrets ?? {});
  const safe = (t: string) => redact(t, secretVals);
  let session: Session | undefined;
  let idx = 0;

  try {
    emit({
      type: "start",
      url: spec.url,
      steps: spec.plan.map((p) => ({ text: safe(p.text), kind: p.kind })),
      hint: spec.hint || undefined,
    });
    // Fresh session, no cacheId → the model replans (true debug, not cache replay).
    session = await launchSession(spec.url, spec.launch);
    if (spec.hint) {
      try {
        (session.agent as { setAIActionContext?: (h: string) => void }).setAIActionContext?.(spec.hint);
      } catch {
        /* older Midscene without action-context — hint is best-effort */
      }
    }
    emit({ type: "navigated", shotRef: await shot(session) });

    for (const step of spec.plan) {
      if (token.cancelled) return;
      emit({ type: "step", idx, kind: step.kind, text: safe(step.text), status: "running" });
      await withModel(() => session!.agent.aiAction(resolveText(step.text, ctx)));
      if (token.cancelled) return;
      emit({
        type: "step",
        idx,
        kind: step.kind,
        text: safe(step.text),
        status: "done",
        shotRef: await shot(session),
      });
      idx += 1;
    }

    if (!spec.expected) {
      emit({ type: "done", status: "passed" });
      return;
    }
    if (token.cancelled) return;
    emit({ type: "assert", assertion: spec.expected, status: "running" });
    try {
      await withModel(() => session!.agent.aiAssert(resolveText(spec.expected!, ctx)));
      emit({ type: "assert", assertion: spec.expected, status: "pass", shotRef: await shot(session) });
      emit({ type: "done", status: "passed" });
    } catch (e) {
      const detail = safe((e as Error).message);
      emit({ type: "assert", assertion: spec.expected, status: "fail", detail, shotRef: await shot(session) });
      emit({ type: "done", status: "failed", failedIdx: idx, failedKind: "assert" });
    }
  } catch (e) {
    const message = safe((e as Error).message);
    // An infra failure means "no verdict", not "the test failed" — the UI colours it differently.
    emit({ type: "step", idx, status: "fail", detail: message, shotRef: await shot(session) });
    emit({ type: "done", status: isInfraError(message) ? "error" : "failed", failedIdx: idx, message });
  } finally {
    await session?.cleanup();
  }
}

function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const flows = (data as { flows?: unknown })?.flows;
  return Array.isArray(flows) ? flows : [];
}
