import { sessionCapability, verifySessionChecks, type SessionCheck } from "./sessionEvidence.js";
import type { ExplorationCharter } from "./charter.js";
import { activationBlocker, matchTarget, type ControlLike } from "./charter.js";
import type { ExplorationTargetSpec } from "./rules.js";
import { buildExplorationReport, type ExplorationReport, type InteractionTarget, type Observation } from "./report.js";
import type { StateFlowGraph } from "../exec/sfg.js";

/**
 * 探索循环里的 charter 记账：哪些目标在哪一屏找到了、试过哪个、为什么没试。
 *
 * 独立成一个类，是为了让 interactive.ts 的改动只剩三处挂点（看到一屏 / 选下一步 / 记结果），
 * 也为了能在没有浏览器的测试里喂合成控件表验证优先级与阻断规则。
 */
export class CharterTracker {
  readonly targets: InteractionTarget[] = [];
  readonly observations: Observation[] = [];
  private readonly attempted = new Set<string>();
  private readonly available: Set<string>;
  /** 上一步刚产出的前提（只活一轮）：用来把链的下一步接在它后面。 */
  private lastProvided = new Set<string>();
  /**
   * 这条链走到一半时手上的「链上前提」。链进行中，**只走链上的步骤**。
   *
   * 2026-09-12 实测：链是「限价 → Mid 取价 → 填量 → 下单」，`Mid` 要等点完限价才出现，
   * 那一轮链接不上，遍历就顺手点了两下 TIF——第二下点中 **IOC**。
   * 于是限价单以 IOC 发出去，在 Mid 价上撮不上，产品回
   * `Order could not match against any resting orders`。
   * 链外的每一次点击都在改这条链的上下文；链没走完之前，别的都得等。
   */
  private chainCaps = new Set<string>();
  /**
   * 链锁连续挡住了多少轮。链上某一步这个产品压根没有时，锁会一直等一个来不了的下一步——
   * 那就把整次探索卡死了。三轮没进展就撤锁，让遍历继续。
   */
  private chainStalled = 0;
  /**
   * 上一步是「链准备好了才挑的」，还是兜底挑的。
   *
   * 只有前者才锁链：建会话这类目标是**前提**，不是链的第一步——它被挑中时链根本还没齐
   * （下单键还要数量和价格）。拿它锁链，链会卡在那儿等一个永远来不了的下一步。
   *
   * 跟着 stableId 记，不能记成一个全局标志：`pendingActivations()`（判断这一轮算不算空转）
   * 也会调 `next()`，它那次调用会把标志冲掉——实测里链锁因此一次都没生效，
   * 遍历照样在链中间点了两下 TIF，第二下点中 IOC，单又被拒。
   */
  private readonly pickReady = new Map<string, boolean>();
  private n = 0;

  private readonly stateChangeSpecs: ExplorationTargetSpec[];

  constructor(readonly charter: ExplorationCharter, available: string[] = [], private readonly sessionChecks: SessionCheck[] = []) {
    this.available = new Set(available.filter(cap => !sessionCapability(cap)));
    this.stateChangeSpecs = charter.featureTargets.filter((t) => t.sideEffect === "state-change");
  }

  setInjectedSessionEvidence(verified: boolean) {
    for (const cap of ['wallet-connected','wallet-identity','wallet-session']) {
      if (verified) this.available.add(cap); else this.available.delete(cap);
    }
  }

  /** 稳定 id：路由 + 目标 + 文案。不吃 nth-of-type——交易页重渲染后路径会漂，文案不会。 */
  private stableId(route: string, spec: ExplorationTargetSpec, c: ControlLike): string {
    return `${route}::${spec.id}::${c.label.replace(/\d+/g, "#").slice(0, 40)}`;
  }

  /** 看到一屏：把命中 charter 的控件登记成 InteractionTarget（看见 ≠ 试过）。 */
  noteState(stateId: string, route: string, elements: ControlLike[], round: number): InteractionTarget[] {
    const verification = verifySessionChecks(this.sessionChecks, elements.map(c => c.label));
    for (const result of verification) {
      if (result.verified) this.available.add(result.capability);
      else this.available.delete(result.capability);
    }
    const found: InteractionTarget[] = [];
    for (const spec of this.charter.featureTargets)
      for (const c of elements) {
        if (!matchTarget(c, spec, route)) continue;
        const stableId = this.stableId(route, spec, c);
        if (this.targets.some((t) => t.stableId === stableId)) continue;
        const t: InteractionTarget = {
          stableId, targetSpecId: spec.id, featureId: spec.featureId, stateId, route,
          role: c.role, label: c.label, display: c.display, selector: c.selector,
          availability: /disabled/.test(c.state) ? "disabled" : "enabled", foundAtRound: round,
        };
        this.targets.push(t);
        found.push(t);
        // 看见就能定的结论当场记：只看的、不许点的、缺前提的。
        const blocker = activationBlocker(c, spec, this.charter.actionsPolicy, this.available, this.stateChangeSpecs, route);
        if (blocker && blocker !== "observe_only")
          this.observations.push({ id: `obs-${++this.n}`, targetId: stableId, targetSpecId: spec.id, featureId: spec.featureId, status: "blocked", stateBefore: stateId, reason: blocker, round, controlsAfter: [], evidenceRefs: [`sfg:state:${stateId}`] });
        else if (blocker === "observe_only")
          this.observations.push({ id: `obs-${++this.n}`, targetId: stableId, targetSpecId: spec.id, featureId: spec.featureId, status: "observed_only", stateBefore: stateId, reason: "observe_only", round, controlsAfter: [], evidenceRefs: [`sfg:state:${stateId}`] });
      }
    return found;
  }

  /**
   * 一条链上的下一步，或者一个还不该现在走的**过早的供给方**。
   *
   * 2026-09-12 实测逼出来的：`T-SIZE-INPUT` 在第 7 轮就把 0.01 填了（它 provides `order-size`），
   * 然后探索按广度继续点订单类型、TIF、方向、杠杆……到第 20 轮才轮到下单。
   * 等点到确认键，面板早就不是当初那一单了，Hyperliquid 回的是
   * `Order could not match against any resting orders`。
   *
   * `requires`/`provides` 管得住**先后**，管不住**连续**。补两条，都只用包里已有的数据，
   * 不需要谁再去声明一份「场景」：
   *
   *   1. 上一步产出了前提 → 下一步优先挑**要这个前提**的目标（链接得上就接着走）。
   *   2. 一个目标产出的前提，消费它的人**还缺别的前提** → 现在走它等于白走，往后放。
   *
   * 第 2 条可能把所有目标都挡住（两个供给方互相等对方），所以 `next` 分两轮：
   * 先只挑不过早的，一个都挑不出来时再放开——宁可顺序不完美，也不能停在原地。
   */
  private readonly consumersCache = new Map<string, ExplorationTargetSpec[]>();
  private readonly depsCache = new Map<string, Set<string>>();

  private consumers(cap: string): ExplorationTargetSpec[] {
    const hit = this.consumersCache.get(cap);
    if (hit) return hit;
    const cs = this.charter.featureTargets.filter((t) => t.requires.includes(cap));
    this.consumersCache.set(cap, cs);
    return cs;
  }

  /**
   * 这条链现在能不能**一口气走到终点** → 走不到就是过早，往后放。
   *
   * 三版都是实测校出来的，每一版都少看一样东西：
   *   一版：只看下一跳 → 「切市价」第 2 轮就合格（填量在它之后确实能走），
   *         等真正下单时它早被后面的遍历改掉了。
   *   二版：递归看链尾，但不看屏幕 → 会话刚建起来、`Place Order` 还没出现时就先填了数量，
   *         紧接着那两下连接把面板重渲染，值被冲掉（回执里 `Est: 0%`，产品拒单）。
   *   三版（现在）：**这一屏上要有一个跑得起来的终点**。终点 = 自己不再产出前提、
   *         或者产出的前提没人接着要的那个目标（下单键、平仓键）。
   *
   * 递归换成了两个集合运算：一边从「手上已有 + 这一步产出」往前滚（只滚这一屏上的目标），
   * 一边看终点往回需要什么。链是个菱形时（价格和数量各自供给下单）递归会漏，集合不会。
   */

  /**
   * 「此刻不在屏幕上」和「这产品里没有」是两回事。
   *
   * `Mid` 只在限价模式下出现——而限价正是这条链的第一步。只认当下这一屏的话，
   * 链的第一步永远等不到它的下一步，链就永远起不来（实测里它只能靠兜底被挑中，
   * 而兜底挑中的那一步不锁链，于是遍历照样插进来）。
   * 之前**见过**就算数：那是这个产品确实有这个控件的证据。终点不放宽——
   * 终点得现在就在屏幕上，否则这条链这一轮根本走不完。
   */
  private reachableSpecs(route: string, elements: ControlLike[]): ExplorationTargetSpec[] {
    // 每一轮只算一次：这里面是 27 个目标 × 上百个控件的正则匹配。
    // 之前每判一个目标「过不过早」就重算一遍，一轮下来几万次 —— 事件循环被堵了三秒多，
    // 看门狗以「没有心跳」把 runner SIGKILL 了，整次运行连回执都没写出来。
    return this.charter.featureTargets.filter((t) =>
      elements.some((c) => matchTarget(c, t, route)) || this.targets.some((seen) => seen.targetSpecId === t.id));
  }

  /**
   * 从「手上已有 + 这一步产出」出发，把这一屏上**这条链下游**的目标的产出滚进来。
   *
   * 只滚下游是关键：下游那几步本来就排在这一步后面（它们要的正是这一步产出的东西），
   * 连着点不会互相抹掉。而「再去点个别的就能拿到」的前提（比如会话）**不算**——
   * 拿它就得离开这条链，回来时前面填的值早没了。实测就是这么丢的。
   */
  private closure(seed: string[], downstreamOf: string[]): Set<string> {
    const caps = new Set([...this.available, ...seed]);
    /**
     * 下游那几步**不要求「之前见过」**——链的后几步本来就是被前几步点出来的。
     *
     * 2026-09-12 实测：`Mid` 第一次被看见是第 26 轮，而它要等第 25 轮点完「限价」才出现。
     * 要求见过的话，点限价的那一刻这条链看起来永远不可能走完，于是限价被判过早、
     * 走了兜底（回执里 `T-ORDER-TYPE-LIMIT … sweep`），链锁没上，
     * 遍历接着点了两下 TIF 把订单改成 IOC——单又被拒。
     * 「Mid 要等限价」这件事包里已经写着：`requires: [order-type-limit]`。
     */
    const downstream = this.charter.featureTargets.filter((t) => downstreamOf.some((p) => this.deps(t).has(p)));
    for (let i = 0; i < 8; i++) {
      let grew = false;
      for (const t of downstream)
        if (t.requires.every((r) => caps.has(r)))
          for (const p of t.provides) if (!caps.has(p)) { caps.add(p); grew = true; }
      if (!grew) break;
    }
    return caps;
  }

  /** 这个目标要跑起来，前前后后需要哪些前提（往回的传递闭包）。 */
  private deps(spec: ExplorationTargetSpec): Set<string> {
    const hit = this.depsCache.get(spec.id);
    if (hit) return hit;
    const need = new Set(spec.requires);
    for (let i = 0; i < 8; i++) {
      const before = need.size;
      for (const cap of [...need])
        for (const t of this.charter.featureTargets)
          if (t.provides.includes(cap)) for (const r of t.requires) need.add(r);
      if (need.size === before) break;
    }
    this.depsCache.set(spec.id, need);
    return need;
  }

  private premature(spec: ExplorationTargetSpec, reachable: ExplorationTargetSpec[]): boolean {
    if (!spec.provides.length) return false;
    const caps = this.closure(spec.provides, spec.provides);
    /**
     * 终点也按「见过就算」认，不要求此刻就在屏幕上。
     *
     * 要求它在屏幕上那一版，实测里链一次都没锁上（回执里 `T-ORDER-TYPE-LIMIT … sweep`）：
     * 点限价的那一刻，下单键正被连接弹窗盖着。
     * 防止「链还没齐就起步」的其实是上面那个闭包——会话没建起来时，
     * 没有任何下游目标产出 `wallet-session`，下单键就永远凑不齐，链自然不会起步。
     */
    for (const t of reachable) {
      if (t.id === spec.id) continue;
      if (t.provides.some((p) => this.consumers(p).length)) continue;   // 还有人接着要 → 不是终点
      if (!t.requires.every((r) => caps.has(r))) continue;              // 这一屏上凑不齐它要的
      if (spec.provides.some((p) => this.deps(t).has(p))) return false; // 这一步确实是它的上游
    }
    return true;
  }

  /** 链上还有没走过的步骤吗（不要求它此刻就在屏幕上——它可能要等上一步点出来）。 */
  private chainPending(route: string, elements: ControlLike[]): boolean {
    for (const t of this.charter.featureTargets) {
      if (t.action !== "activate" && t.action !== "fill") continue;
      if (![...this.chainCaps].some((c) => this.deps(t).has(c))) continue;
      const done = elements.some((c) => matchTarget(c, t, route) && this.attempted.has(this.stableId(route, t, c)));
      if (!done) return true;
    }
    return false;
  }

  /** 这一屏上下一个该点的 charter 目标；按 charter 里的目标顺序（领域顺序），不按 DOM 顺序。 */
  next(route: string, elements: ControlLike[]): { target: InteractionTarget; spec: ExplorationTargetSpec; control: ControlLike } | undefined {
    // 链优先：上一步刚产出的前提，谁在等它，谁先走。
    const reachable = this.reachableSpecs(route, elements);
    const chained = this.lastProvided.size
      ? this.charter.featureTargets.filter((t) => t.requires.some((r) => this.lastProvided.has(r)))
      : [];
    /**
     * 兜底那一轮（几个供给方互相等对方，谁都不合格）里，**按「产出有多经得住放」排**：
     *
     *   state-change（会话、已提交的东西）  最经放——别的点击改不掉它
     *   ui-only（tab、开关）              会被后面的遍历翻回去
     *   fill（填进输入框的值）             最易挥发，一次重渲染就没了
     *
     * 两版都是实测校出来的：第一版按包里的顺序挑，挑中填数量，又变回「第 7 轮填、第 20 轮下单」；
     * 第二版只把 fill 放最后，挑中的是「切市价」，等真下单时它早被后面的遍历改掉了。
     */
    const durability = (t: ExplorationTargetSpec): number =>
      t.sideEffect === "state-change" ? 0 : t.action === "fill" ? 2 : 1;
    // Cover a new business target before repeating an already exercised target on another route.
    const visitedSpec = (id: string) => this.observations.some(o=>o.targetSpecId===id && ['attempted','observed_only','skipped_equivalent'].includes(o.status));
    const coverageFirst = [...this.charter.featureTargets].sort((a,b)=>Number(visitedSpec(a.id))-Number(visitedSpec(b.id)));
    const durableFirst = [...coverageFirst].sort((a, b) => durability(a) - durability(b));
    if (this.chainCaps.size) {
      const onChain = this.charter.featureTargets.filter((t) => [...this.chainCaps].some((c) => this.deps(t).has(c)));
      const step = this.pick(chained, route, elements, false, reachable) ?? this.pick(onChain, route, elements, true);
      if (step) { this.chainStalled = 0; this.pickReady.set(step.target.stableId, true); return step; }
      this.chainStalled += 1;
      // 链上没有一步能走：可能是下一步还没被上一步点出来。这一轮不动 charter 目标——
      // 链外的点击会改掉链的上下文，宁可空过一轮。链上一个都没剩时才放开。
      if (this.chainStalled <= 3 && this.chainPending(route, elements)) return undefined;
      this.chainCaps.clear();
      this.chainStalled = 0;
    }
    const ready = this.pick(chained, route, elements, false, reachable)
      ?? this.pick(coverageFirst, route, elements, false, reachable);
    if (ready) { this.pickReady.set(ready.target.stableId, true); return ready; }
    const last = this.pick(durableFirst, route, elements, true);
    if (last) this.pickReady.set(last.target.stableId, false);
    return last;
  }

  private pick(specs: ExplorationTargetSpec[], route: string, elements: ControlLike[], allowPremature: boolean, reachable: ExplorationTargetSpec[] = []):
    { target: InteractionTarget; spec: ExplorationTargetSpec; control: ControlLike } | undefined {
    for (const spec of specs) {
      if (spec.action !== "activate" && spec.action !== "fill") continue;
      if (!allowPremature && this.premature(spec, reachable)) continue;
      for (const c of elements) {
        if (!matchTarget(c, spec, route)) continue;
        const stableId = this.stableId(route, spec, c);
        if (this.attempted.has(stableId)) continue;
        if (activationBlocker(c, spec, this.charter.actionsPolicy, this.available, this.stateChangeSpecs, route)) continue;
        // 已经处于目标态的选项（当前选中的 tab）不用再切：切它什么也不会发生，白花一轮。
        if (/(selected|checked|pressed)=true|cls:(on|active|selected)/.test(c.state)) { this.attempted.add(stableId); this.observations.push({ id: `obs-${++this.n}`, targetId: stableId, targetSpecId: spec.id, featureId: spec.featureId, status: "skipped_equivalent", stateBefore: this.targets.find(t => t.stableId === stableId)?.stateId ?? "unknown", reason: "already_active", round: 0, controlsAfter: [], evidenceRefs: [] }); continue; }
        const target = this.targets.find((t) => t.stableId === stableId) ?? { stableId, targetSpecId: spec.id, featureId: spec.featureId, stateId: "", route, role: c.role, label: c.label, display: c.display, selector: c.selector, availability: "enabled" as const, foundAtRound: 0 };
        return { target, spec, control: c };
      }
    }
    return undefined;
  }

  markAttempted(stableId: string): void { this.attempted.add(stableId); }

  record(o: Omit<Observation, "id">): Observation {
    const obs: Observation = { id: `obs-${++this.n}`, ...o };
    this.observations.push(obs);
    /**
     * 点成了就把这个目标**产出的前提**记为可用，后面依赖它的目标才有机会被点。
     *
     * 没有这一步，`provides` 只是一个写在包里的说明；有了它，「连钱包 → 会话可用 →
     * 下单目标解锁」这条链才真的接得上。只认 `attempted`：blocked / not_found 的目标
     * 什么也没产出，拿它们去解锁别人就是把没发生的事当成发生过。
     */
    if (obs.status === "attempted") {
      const spec = this.charter.featureTargets.find((t) => t.id === obs.targetSpecId);
      // 这一步刚产出的前提单独记一份：下一轮先找「在等它的那个目标」，链才连得上。
      this.lastProvided = new Set((spec?.provides ?? []).filter(cap => !sessionCapability(cap)));
      for (const cap of this.lastProvided) this.available.add(cap);
      // 产出的前提还有人要 → 链还在走；走到终点（产出没人要，或压根没产出）→ 链结束。
      const ready = this.pickReady.get(obs.targetId) ?? false;
      // 回执里说清这一步是**链上的一步**还是**扫到的**：两者的证据分量不一样，
      // 而且链断在哪一步、为什么断，只有这一行看得出来。
      if (!obs.reason) obs.reason = ready ? "chain" : "sweep";
      if (ready)
        for (const cap of this.lastProvided) if (this.consumers(cap).length) this.chainCaps.add(cap);
      if (!ready || (spec && !spec.provides.some((c) => this.consumers(c).length))) this.chainCaps.clear();
    } else if (obs.status === "blocked" || obs.status === "failed") this.lastProvided = new Set();
    return obs;
  }

  /** 目前手上有哪些前提（初始种子 + 已经点出来的 `provides`）。回执里要说得出。 */
  capabilities(): string[] { return [...this.available]; }

  /** 还有没有能点的 activate 目标（决定 dry 计数是否该豁免）。 */
  pendingActivations(route: string, elements: ControlLike[]): boolean { return !!this.next(route, elements); }

  report(graph: StateFlowGraph, stop: { kind: string; n?: number }, budget: { maxScreens: number; screens: number; rounds: number; maxRounds: number }, unknowns: string[] = []): ExplorationReport {
    return buildExplorationReport({ charter: this.charter, graph, targets: this.targets, observations: this.observations, stop, budget, unknowns });
  }
}
