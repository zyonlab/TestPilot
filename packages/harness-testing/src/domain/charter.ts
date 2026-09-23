import { z } from "zod";
import { DomainIdSchema, ExplorationTargetSpecSchema, type ExplorationTargetSpec, type ProductRulePack } from "./rules.js";

/**
 * 探索 charter：这一次探索**要查什么**，以及**不许做什么**。
 *
 * 它取代了「探索前先问模型猜几条故事」作为决定先点哪里的依据（那一步仍可保留为对照臂）。
 * 候选目标不是用户故事——故事等产品模型出来之后才写（docs/v3/history/20 §4「模型故事计划过早」）。
 */
export const ActionsPolicySchema = z
  .object({
    /** 探索里允许的动作只有「激活 UI」：切 tab、勾选、开面板。 */
    allow: z.array(z.enum(["activate-ui"])).default(["activate-ui"]),
    /**
     * **沙箱模式**：允许探索点会改状态的目标（提交、删除、确认、连接账户）。
     *
     * 默认 false，而且它不是探索器自己能开的开关——由运行显式声明 `exploreActions:"interact"`，
     * 服务端再用禁止名单把关（`workflowOps`）。理由和执行层
     * 那道守卫是同一条：**判断「这个地址下可不可以做不可逆的事」的是人，不是模型**。
     * 打开之后 `forbidLabels` 与 `neverSubmit` 一并让位——半开的沙箱比不开更难解释。
     */
    allowStateChange: z.boolean().default(false),
    /** 词表只是第二道保险；第一道是目标本身的 sideEffect 等级。 */
    forbidLabels: z.array(z.string()).default([]),
    neverSubmit: z.literal(true).default(true),
  })
  .strict();
export type ActionsPolicy = z.infer<typeof ActionsPolicySchema>;

export const ExplorationCharterSchema = z
  .object({
    schemaVersion: z.literal("exploration-charter.v1"),
    id: DomainIdSchema,
    rulePack: z.object({ id: DomainIdSchema, version: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    scope: z
      .object({
        entryUrl: z.string().url(),
        /** 允许走到的路由（正则）。空数组 = 只在入口路由上工作，不让全局导航把预算带走。 */
        routes: z.array(z.string()).default([]),
        /**
         * 允许走到的**完整地址**（正则），抄自规则包的 `appliesTo.urlPatterns`。
         *
         * 2026-09-15 拿 Vikunja 跑带规则包的探索：登录之后 7 屏全停在 `/`，`/projects`
         * `/labels` `/teams` 一个没去，规则包里指向那几页的目标全记 not_found。原因是
         * `routes` 从来没人填——`sourceKnowledge` 建 charter 时不传——于是「空数组 = 只在
         * 入口路由上工作」对每个产品都成立。那条默认是给 Hyperliquid `/trade` 这种业务全在
         * 一页里的产品定的，换成多页应用就把探索关在门口。
         *
         * 范围本来就写在包里：包说自己覆盖哪些地址，探索就能去哪些地址。没写的包行为不变。
         */
        urlPatterns: z.array(z.string()).default([]),
      })
      .strict(),
    entryStates: z.array(z.string()).default(["logged-out"]),
    featureTargets: z.array(ExplorationTargetSpecSchema).min(1),
    ruleRefs: z.array(DomainIdSchema).default([]),
    actionsPolicy: ActionsPolicySchema.default({}),
    budgets: z.object({ maxScreens: z.number().int().nonnegative(), maxRounds: z.number().int().positive().optional() }).strict(),
    completionCriteria: z.object({ allTargetsAttempted: z.literal(true).default(true) }).strict().default({}),
    environmentRef: z.string().optional(),
  })
  .strict();
export type ExplorationCharter = z.infer<typeof ExplorationCharterSchema>;

/**
 * 默认禁点词表。它**不是**副作用判定的依据（那是目标的 sideEffect），只是在目标匹配
 * 出错时的兜底：一个 charter 说「Reduce Only 是 ui-only」，而页面上恰好有个叫
 * `Reduce Only & Place` 的按钮，词表能拦住这一次。
 */
export const DEFAULT_FORBID_LABELS = [
  // 任何 Web 产品上都成立的破坏性动作：删掉、清空、退出登录。
  "delete", "remove", "reset", "log ?out", "sign ?out", "删除", "移除", "清空", "退出",
  // 提交一张表单：是不是不可逆要看产品，但「提交」本身在哪都值得先拦一道。
  "\\bsubmit\\b", "\\bconfirm\\b", "提交", "确认",
];
/**
 * 词表里**不放行业词**。
 *
 * 这里留下的只有换任何一个 Web 产品都还成立的两类：破坏性动作（删除 / 清空 / 退出登录）、
 * 以及「提交 / 确认」这种把表单交出去的动作。
 *
 * 挪走的是行业词，它们跟着规则包走（`pack.forbidLabels`）：
 *   - 交易类：deposit / withdraw / transfer / close position / cancel all / 下单 / 平仓 / 撤单 / 充值 / 提现
 *   - 链上钱包类：place / approve / sign / connect
 * `place`（place order）、`connect`（connect wallet）、`approve`（授权代币）、`sign`（签名）
 * 只有在做加密产品时才是副作用动词；在一个 CMS 上 `place` 什么都不是，而 CMS 真正该拦的
 * 「发布」这个词，这份默认词表里一个字都没有——**焊死一个行业的词表，换个产品就是
 * 带着别人的副作用观念去探索**。
 */
/**
 * 词表里**不放方向词**（buy / sell / long / short）。
 *
 * 第一版放了，结果 2026-09-11 在 app.hyperliquid.xyz 上把「Buy / Long」「Sell / Short」
 * 这两个**方向切换**判成了禁点——charter 明写它们是 ui-only，词表越过声明把它们挡掉，
 * 于是订单方向这个 P0 功能一次都没被展开。方向切换本身不改变任何账户状态。
 *
 * 有的产品把提交按钮就叫「Buy / Long」。那种情况由**声明**处理：把提交目标标成
 * state-change（本仓库的 Hyperliquid 规则包用 `^(Buy|Sell) ` 匹配提交按钮），
 * 再由下面的交叉检查兜底——一个控件只要命中任何一个 state-change 目标，
 * 不管现在为哪个目标激活它，一律拒绝。声明比词表准，交叉检查比词表安全。
 */

/**
 * charter 的 id：`charter-<packId>-<version>`，但要保证它过得了 `DomainIdSchema`。
 *
 * 规则包的 `version` 已经在 schema 那一层收紧过字符集；这里再兜一层长度——id 上限 120 字，
 * 而包 id 与版本号都是人写的，拼起来超长不是不可能。宁可截断，也不要在探索开始的
 * 第 4 毫秒抛一条看不出因果的正则错（2026-09-16 真撞过一次）。
 */
export function charterId(packId: string, version: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.:/-]/g, "-");
  return `charter-${safe(packId)}-${safe(version)}`.slice(0, 120);
}

export function charterFromRulePack(
  pack: ProductRulePack,
  packHash: string,
  opts: { entryUrl: string; maxScreens: number; maxRounds?: number; routes?: string[]; environmentRef?: string; id?: string; allowStateChange?: boolean },
): ExplorationCharter {
  return ExplorationCharterSchema.parse({
    schemaVersion: "exploration-charter.v1",
    id: opts.id ?? charterId(pack.id, pack.version),
    rulePack: { id: pack.id, version: pack.version, hash: packHash },
    scope: { entryUrl: opts.entryUrl, routes: opts.routes ?? [], urlPatterns: pack.appliesTo.urlPatterns },
    featureTargets: pack.targets,
    ruleRefs: pack.rules.map((r) => r.id),
    actionsPolicy: { forbidLabels: [...DEFAULT_FORBID_LABELS, ...pack.forbidLabels], ...(opts.allowStateChange ? { allowStateChange: true } : {}) },
    budgets: { maxScreens: opts.maxScreens, ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}) },
    ...(opts.environmentRef ? { environmentRef: opts.environmentRef } : {}),
  });
}

/** 探索循环里一个控件的最小形状；和 interactive.ts 的 Control 兼容，不引用它。 */
export interface ControlLike {
  display: string;
  label: string;
  selector: string;
  role: string;
  href: string;
  external: boolean;
  submit: boolean;
  clickable: boolean;
  fillable: boolean;
  state: string;
  /** 这个控件所在容器（弹窗/抽屉）的文案。采集器给；不在任何容器里就是空。 */
  container?: string;
}

/** `button[button]: Limit` → `button`；`input[checkbox]: Reduce Only` → `input`。 */
export const tagOf = (display: string): string => display.split(":")[0]!.replace(/\[.*$/, "").trim();
/** `input[checkbox]` → `checkbox`。 */
export const inputTypeOf = (display: string): string => display.match(/^\w+\[([^\]]+)\]/)?.[1] ?? "";

/**
 * 正则编译缓存：同一批模式在一轮里要对上百个控件各试一遍。
 * 没有它，探索每挑一步就要编译几万次正则——实测把事件循环堵了三秒多，
 * 看门狗以「没有心跳」把 runner 杀了，整次运行连回执都没写出来。
 */
const reCache = new Map<string, RegExp | null>();
const compile = (p: string, flags: string): RegExp | null => {
  const key = `${flags}\u0000${p}`;
  if (reCache.has(key)) return reCache.get(key)!;
  let re: RegExp | null = null;
  try { re = new RegExp(p, flags); } catch { re = null; }
  reCache.set(key, re);
  return re;
};
const anyMatch = (patterns: string[], text: string, flags = "i"): boolean =>
  patterns.some((p) => compile(p, flags)?.test(text) ?? false);

/** 一个控件是不是这个目标要找的东西。文案匹配 + 角色约束 + 路由约束；不看选择器。 */
export function matchTarget(control: ControlLike, spec: ExplorationTargetSpec, route: string): boolean {
  if (control.external) return false;
  if (spec.match.route && !(compile(spec.match.route, "")?.test(route) ?? false)) return false;
  /**
   * 容器限定先判：声明了 `within` 的目标只认待在那个容器里的控件。
   *
   * 采集器没给容器文案时（旧数据、或这个控件不在任何弹窗里），**声明了 within 的目标一律不匹配**——
   * 宁可漏，不可点错：点错的代价是把方向按钮当成确认键，然后宣称订单提交过了。
   */
  if (spec.match.within.length && !anyMatch(spec.match.within, control.container ?? "")) return false;
  if (!anyMatch(spec.match.label, control.label)) return false;
  if (spec.match.roles.length) {
    const tag = tagOf(control.display);
    const type = inputTypeOf(control.display);
    const kinds = new Set([tag, control.role, type].filter(Boolean));
    if (!spec.match.roles.some((r) => kinds.has(r.toLowerCase()))) return false;
  }
  return true;
}

/**
 * 这个目标现在能不能点。返回 undefined = 可以；否则是阻断原因（进回执，不删目标）。
 */
export function activationBlocker(
  control: ControlLike,
  spec: ExplorationTargetSpec,
  policy: ActionsPolicy,
  available: Set<string>,
  /** 同一个 charter 里所有 state-change 目标，用于交叉检查；见 DEFAULT_FORBID_LABELS 上方那段。 */
  stateChangeSpecs: ExplorationTargetSpec[] = [],
  route = "",
): string | undefined {
  if (spec.action === "observe-only") return "observe_only";
  // fill 目标就是冲着输入框去的：下面那条「文本框不支持」的规矩对它不适用。
  if (spec.action === "fill") return spec.value ? undefined : "fill_without_value";
  const sandbox = policy.allowStateChange === true;
  if (!sandbox && spec.sideEffect === "state-change") return "policy:side_effect";
  /**
   * **一个控件同时命中两个目标＝不知道自己在点什么，沙箱也不例外。**
   *
   * 这条检查原来和「不许改状态」写在一起，我开沙箱时把两条一起关掉了——2026-09-12 当场
   * 付出代价：`T-CONFIRM` 的文案写了 `^Buy / Long$`，而下单面板的**方向切换**也叫这个名字
   * （材料里出现 46 次）。于是「确认下单」这个 state-change 目标点到的是方向按钮，
   * 回执上还记成 attempted。**沙箱放开的是「可以改状态」，不是「点错也无所谓」。**
   */
  /**
   * 歧义检查里**更具体的目标优先**。
   *
   * `Buy / Long` 同时命中「方向切换」和「弹窗里的确认键」；后者声明了 `within`，
   * 前者没有。两个都算歧义的话，加了容器限定等于白加——所以：本目标声明了 `within` 时，
   * 只跟同样声明了 `within` 的目标比。
   */
  const rivals = spec.match.within.length ? stateChangeSpecs.filter((t) => t.match.within.length) : stateChangeSpecs;
  const alsoAction = rivals.find((t) => t.id !== spec.id && matchTarget(control, t, route));
  if (alsoAction) return `policy:matches_state_change:${alsoAction.id}`;
  const missing = spec.requires.filter((r) => !available.has(r));
  if (missing.length) return `requires:${missing.join(",")}`;
  if (!sandbox && control.submit && policy.neverSubmit) return "policy:submit_control";
  if (!sandbox && anyMatch(policy.forbidLabels, control.label)) return "policy:forbidden_label";
  if (/disabled/.test(control.state)) return "control_disabled";
  const tag = tagOf(control.display);
  if (tag === "select" || (control.fillable && tag !== "input") || (tag === "input" && !["checkbox", "radio", "button", "submit"].includes(inputTypeOf(control.display))))
    return "unsupported:value_input";
  if (!control.clickable && !["checkbox", "radio", "tab", "switch", "option", "menuitemradio", "menuitemcheckbox"].includes(control.role) && !["checkbox", "radio"].includes(inputTypeOf(control.display)))
    return "unsupported:not_clickable";
  return undefined;
}

/**
 * 这个地址探索能不能去。路由正则对路径判，`urlPatterns` 对完整地址判（它们在包里就是这么写的）。
 * 不给 `url` 时只看路由——调用方拿不到完整地址的地方，宁可保守。
 */
export const routeAllowed = (charter: ExplorationCharter | undefined, entryRoute: string, route: string, url?: string): boolean => {
  if (!charter || route === entryRoute) return true;
  const hits = (patterns: readonly string[] | undefined, subject: string) =>
    (patterns ?? []).some((r) => { try { return new RegExp(r).test(subject); } catch { return false; } });
  return hits(charter.scope.routes, route) || (url !== undefined && hits(charter.scope.urlPatterns, url));
};
