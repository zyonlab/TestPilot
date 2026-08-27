// Interactive sessions: exploration and step-by-step debugging.
//
// Unlike a case run, these are *streamed* — the UI watches the page while the model
// thinks. They emit frames instead of returning one result, and screenshots leave as file
// refs: the frames also land in lineage, and lineage must not fill up with base64 JPEGs.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveText, redact, withModel, type ResolveContext } from "@testpilot/harness-core";
import { launchSession, type LaunchOpts, type Session } from "./session.js";
import { isInfraError } from "../failure.js";
import {
  abstractionOf,
  describeGraph,
  routeOf,
  type SfgState,
  type SfgTransition,
  type StateFlowGraph,
} from "./sfg.js";

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
  execId: string;
  url: string;
  artifactDir: string;
  /** 往前走，而不是只看入口页。关掉就退回单屏采集。 */
  deep?: boolean;
  settleMs?: number;
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
  /** 走过的那张图。点和**边**都在——边此前是被丢掉的那一半。 */
  graph?: StateFlowGraph;
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
  }

  /** 一屏的事实：地址、标题、正文、可交互控件的可见文案。 */
  const snapshot = async (
    label: string,
  ): Promise<{ text: string; url: string; title: string; controls: string[]; elements: Control[] }> => {
    const page = session!.page as unknown as {
      url(): string;
      title(): Promise<string>;
      evaluate<T>(fn: () => T): Promise<T>;
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
        [...document.querySelectorAll("button, a, input, select, textarea, [role=button]")]
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
          .slice(0, 60)
          .map((el) => {
            const e = el as HTMLElement & { placeholder?: string; type?: string; href?: string };
            const label =
              (e.innerText || "").trim() ||
              e.getAttribute("aria-label") ||
              e.placeholder ||
              e.getAttribute("name") ||
              "";
            // 站外链接标出来。不标，探索会顺着页脚的社交链接走出这个产品。
            let external = false;
            let path = "";
            try {
              if (e.href) {
                const u = new URL(e.href, location.href);
                external = u.origin !== location.origin;
                if (!external) path = u.pathname + u.search;
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
            const fallback = e.getAttribute("title") || e.getAttribute("data-test") || path;
            const shown = label || (fallback ? `（无可见文案·${fallback}）` : "");
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

            return {
              display: `${tag}${e.type ? `[${e.type}]` : ""}${external ? "[外站]" : ""}: ${shown.slice(0, 60)}${path ? ` -> ${path}` : ""}`,
              label: shown.slice(0, 60),
              selector,
              href: path,
              external,
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
    const controls = elements.map((e) => e.display);

    return {
      url: page.url(),
      title,
      controls,
      elements,
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
  const abstract = abstractionOf(spec.stateAbstraction);
  const signatureOf = (screen: { url: string; controls: string[]; title?: string }): string =>
    abstract(screen);

  try {
    emit({ type: "start", url: spec.url });
    session = await launchSession(spec.url, spec.launch);
    emit({ type: "navigated", shotRef: await shot(session) });
    if (spec.settleMs) await new Promise((r) => setTimeout(r, spec.settleMs));

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

    const first = await snapshot("入口页");
    const screens: string[] = [first.text];
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
      const route = routeOf(screen.url).split("?")[0];
      const nth = sfgStates.filter((st) => st.route === route).length;
      const id = nth === 0 ? route : `${route}#${nth}`;
      idBySig.set(sig, id);
      sfgStates.push({
        id,
        route,
        title: screen.title ?? "",
        controls: screen.controls.slice(0, 60),
      });
      return id;
    };
    let currentId = idFor(first);
    /**
     * 试过什么，按**地址**记，不按屏幕签名记。
     *
     * 第一版按签名记，于是菜单一打开签名就变，同一个「Open Menu」在新签名下又成了没试过的
     * ——菜单开↔关来回抖，每一轮都把对方的控件当成新的，探索原地转圈直到 dry 用尽。
     * 签名的用途是「这算不算一屏新的」，不是「我做过什么」；后者跟着地址走才稳。
     */
    const triedClick = new Set<string>();
    /** 去过的地址。同一个地址走第二次对发现新界面没有任何帮助。 */
    const triedGoto = new Set<string>();
    const pathOf = (u: string): string => {
      try {
        const x = new URL(u);
        return x.pathname + x.search;
      } catch {
        return u;
      }
    };
    let current = first;
    triedGoto.add(pathOf(first.url));
    let stoppedBecause = spec.deep === false ? "只采入口页（deep 关闭）" : "";
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
      | { key: string; kind: "click"; selector: string; label: string }
      | { key: string; kind: "goto"; href: string };
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
      for (const c of ordered) {
        // 外站不点：探索的对象是这个产品，不是它页脚链到的地方。
        if (c.external || !c.clickable || OFF_LIMITS.test(c.display)) continue;
        /**
         * 指向别处的链接直接走过去；**指向当前地址的不是「没地方去」，是 JS 驱动的链接**。
         *
         * SauceDemo 的商品链接全是 `href="#"`，解析出来等于当前地址。把它们当成
         * 「已经在这儿了」全部跳过，商品详情就一个都进不去——一个把整块功能判成
         * 「不用去」的规则，比没有规则更糟，因为它看起来是在正常工作。
         */
        if (c.href && c.href !== here) {
          if (triedGoto.has(c.href)) continue;
          return { key: c.href, kind: "goto", href: c.href };
        }
        const key = `${here}::${c.selector}`;
        if (triedClick.has(key)) continue;
        return { key, kind: "click", selector: c.selector, label: c.label };
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
        const page = session!.page as unknown as { goBack?: () => Promise<unknown> };
        if (!page.goBack) {
          stoppedBecause = "这一屏能点的都点过了，而且退不回去";
          break;
        }
        note("这一屏能点的都点过了，退回上一屏");
        try {
          const before = signatureOf(current);
          await page.goBack();
          await new Promise((r) => setTimeout(r, spec.settleMs ?? 1500));
          current = await snapshot(`回退后`);
          /**
           * 退不动就停。
           *
           * 走到历史开头之后 `goBack()` 什么也不做，而这一轮又没试任何控件——于是它会
           * 一直「退」到预算烧光。实测一次 40 轮里有 32 轮就是这么没的。
           * 退了一步却回到同一屏，说明这条路已经走到头了。
           */
          if (signatureOf(current) === before) {
            stoppedBecause = "能点的都点过了，也退不动了";
            break;
          }
          continue;
        } catch {
          stoppedBecause = "这一屏能点的都点过了，而且退不回去";
          break;
        }
      }
      if (next.kind === "goto") triedGoto.add(next.href);
      else triedClick.add(next.key);

      try {
        const page = session!.page as unknown as {
          goto: (u: string) => Promise<unknown>;
          $eval: (sel: string, fn: (el: unknown) => unknown) => Promise<unknown>;
        };
        if (next.kind === "goto") {
          note(`第 ${rounds} 轮：走到 ${next.href}`);
          await page.goto(new URL(next.href, current.url).toString());
        } else if (next.kind === "click") {
          /**
           * **按选择器点，不问模型。**
           *
           * 这个元素是我们自己刚采下来的，选择器也是自己生成的。把它翻译成
           * 「Click "shopping-cart-link"」再让一个看截图的模型去屏幕上找回来，是纯损失：
           * `data-test` 这种名字屏幕上根本不显示，模型找不到，而且**不报错，只是什么都不做**
           * ——一次实测里连着四轮都是这样，每一轮都被记成「没有新界面」。
           */
          note(`第 ${rounds} 轮：点 ${next.label}（${next.selector}）`);
          /**
           * **页内 DOM 点击，不是真实鼠标点击。**
           *
           * 实测：`page.click`（真实鼠标）点 SauceDemo 的商品链接**不换屏**，而页内
           * `el.click()` 换。这类链接靠 JS 处理，真实鼠标的落点到不了它的处理器上。
           * 探索要的是覆盖，不是交互保真——保真是执行用例那一层的事。
           */
          await page.$eval(next.selector, (el) => (el as HTMLElement).click());
        } else {
          // 日志里留模板，明文永不落盘——和执行用例同一条规矩。
          note(`第 ${rounds} 轮：${next.instruction}`);
          const resolved = spec.resolve ? resolveText(next.instruction, spec.resolve) : next.instruction;
          await withModel(() => session!.agent.aiAction(resolved));
        }
        await new Promise((r) => setTimeout(r, spec.settleMs ?? 1500));
        emit({ type: "navigated", shotRef: await shot(session) });

        const after = await snapshot(`第 ${screens.length + 1} 屏`);
        const sig = signatureOf(after);
        const wasNew = !seen.has(sig);
        const toId = idFor(after);
        sfgEdges.push({
          from: currentId,
          to: toId,
          action:
            next.kind === "goto"
              ? { kind: "goto", target: next.href, selector: "" }
              : next.kind === "login"
                ? { kind: "login", target: "登录表单", selector: "", input: "${env.*} / ${secret.*}" }
                : { kind: "click", target: next.label, selector: next.selector },
          ok: true,
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
        currentId = toId;
        current = after;
        if (seen.has(sig)) {
          // 原地打转也要记一笔：它是「这个产品就这么大」和「探索走不动了」之间的区别。
          dry += 1;
          note(`没有新界面（连续 ${dry}/${dryLimit} 次）`, "warn");
          continue;
        }
        seen.add(sig);
        triedGoto.add(pathOf(after.url));
        visited.push(after.url);
        screens.push(after.text);
        dry = 0;
        consecutiveFailures = 0;
        note(`第 ${screens.length} 屏：${after.url}，${after.controls.length} 个控件`);
      } catch (e) {
        // 走不进去本身就是观察结果的一部分：下游会把它记成「没看到的」。
        const why = (e as Error).message.split("\n")[0].slice(0, 160);
        note(`没能往前走：${why.slice(0, 70)}`, "warn");
        const what =
          next.kind === "goto" ? `走到 ${next.href}` : next.kind === "click" ? `点 ${next.label}` : next.instruction;
        missed.push(`${what} —— ${why}`);
        // 走不通也是一条边：它记的是「这条路走不过去」，而那正是下游「没有答案的地方」
        // 的来源之一。丢掉它，材料就只剩成功路径，看起来像这个产品没有走不通的地方。
        sfgEdges.push({
          from: currentId,
          action:
            next.kind === "goto"
              ? { kind: "goto", target: next.href, selector: "" }
              : next.kind === "login"
                ? { kind: "login", target: "登录表单", selector: "" }
                : { kind: "click", target: next.label, selector: next.selector },
          ok: false,
          note: why,
        });
        consecutiveFailures += 1;
      }
    }
    if (!stoppedBecause)
      stoppedBecause = token.cancelled
        ? "被取消"
        : screens.length >= maxScreens
          ? `采满 ${maxScreens} 屏的上限`
          : rounds >= maxRounds
            ? `用完 ${maxRounds} 次动作预算`
            : consecutiveFailures >= 3
              ? "连续 3 次点不动"
              : `连续 ${dryLimit} 轮没有发现新界面`;
    note(`探索结束：${screens.length} 屏 / ${rounds} 轮，${stoppedBecause}`);

    /**
     * 走到过什么、以及**没走到什么**，一起交出去。
     *
     * 后半句是这份材料唯一能自证薄不薄的地方：`spec.compose` 被要求把材料没说的记进
     * 「没有答案的地方」，而它只有在材料自己说了「这里我没看到」的时候才做得到。
     */
    const graph: StateFlowGraph = {
      abstraction: spec.stateAbstraction ?? "route+controls",
      entry: sfgStates[0]?.id ?? "",
      states: sfgStates,
      transitions: sfgEdges,
      stoppedBecause,
    };

    const coverage = [
      "===== 这次探索走到哪为止 =====",
      `采到 ${screens.length} 屏（上限 ${maxScreens}），走了 ${rounds} 轮，停止原因：${stoppedBecause}`,
      `走过的地址：${visited.join(" , ")}`,
      ...(missed.length ? ["没能走进去的地方：", ...missed.map((m) => `- ${m}`)] : []),
      "这份材料只覆盖上面列出的界面。没有出现在这里的功能，是没有被看到，不是不存在。",
    ].join("\n");

    return {
      // 图的摘要跟着材料一起走：下游整理规格时**先看结构再看正文**——
      // 实证研究的结论是「精简的功能级上下文」对 LLM 最有效，原始屏幕转储不是。
      notes: [...screens, describeGraph(graph), coverage].join("\n\n"),
      url: spec.url,
      log,
      shotRef: await shot(session),
      screens: screens.length,
      stoppedBecause,
      graph,
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
    if (spec.settleMs) await new Promise((r) => setTimeout(r, spec.settleMs));

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
