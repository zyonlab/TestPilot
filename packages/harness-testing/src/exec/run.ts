import { executionObserver, type ExecutionObservation } from '@testpilot/harness-core/execution-observation';
import { checkPrerequisite, type Preparation, type EnvironmentFact, type PrerequisiteReceipt } from './preparationChecks.js';
import {authenticationState,shouldRunLogin,type AuthenticationChecks} from './authentication.js';
import {settleOn} from './pageReady.js';
import { cacheDigest } from './cache.js';
import { pickLocator, locatorUsable, type LocatorHint } from "./locators.js";
// The executor: drive Midscene steps against a target, capture what a run leaves behind
// (screenshots, perf metrics, oracle results) and hand it back. It knows nothing about the
// database, baselines or artifacts — those live in the gateway, which is why this can run
// in the runner process.
import { launchSession, reopenPage } from "./session.js";
import { createHash } from "node:crypto";
import { acquireSession, evictSession, releaseSession, replaceSession } from "./sessionPool.js";
import type { RunPhases } from "../report.js";
import { startPopupApprover } from "./wallet.js";
import { snapshotBalances, evalChainAssertion, collectReceipts, evalTxSubmitted } from "./chain.js";
import { capturePerf, type PerfMetrics } from "../baselines/perf.js";
import { resolveText, redact, withModel, type ResolveContext } from "@testpilot/harness-core";
import type { ChainAssertion, OracleCheck, StorageState } from "../types.js";
import { describeOracle, evaluateOracle, type MachineOracle, type PageSnapshot } from "./oracle.js";
import { sampleJudge } from "./judge.js";
import { classifyFailure, isInfraError, type Failure } from "../failure.js";
import { observeApi } from "./apiOracle.js";
import { isOpenQuestion, navigationTarget } from "./stepSemantics.js";
import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";
import { executorConnectionFromEnv, type RoleRequestRecord, type RoleProxyBudget } from "@testpilot/harness-core";

export interface RunResult {
  observation?: ExecutionObservation;
  observations?: Array<{step:number;text:string;url:string;capturedAt:number}>;
  prerequisiteChecks?: PrerequisiteReceipt[];
  environmentFacts?: EnvironmentFact[];
  auxiliaryChecks?: Array<OracleCheck & {id:string;supports:string[]}>;
  recipeChecks?: Array<PrerequisiteReceipt & {phase:"entry"|"postcondition"}>;
  /** Exact proxied requests; absent means unavailable, never guessed from step count. */
  modelRequests?: RoleRequestRecord[];
  /** `unobservable`：没有一条判据失败，但至少一条没量到——没有判决，不是通过。 */
  status: "passed" | "failed" | "unobservable";
  durationMs: number;
  /** 墙钟分段（`report.ts` 的 `RunPhases`）。出错时是走到哪算到哪。 */
  phases: RunPhases;
  startedAt: string;
  logs: string[];
  screenshots: string[];
  pngBuffers: Buffer[]; // lossless PNG per screenshot, aligned with `screenshots`, for visual diff
  sinceMs: number; // when the run started (to locate its Midscene report)
  perfMetrics: PerfMetrics; // navigation/paint timing of the page under test
  oracle: OracleCheck[]; // functional assertion results (from the case's `expected`)
  failureReason?: string;
  /** 哪条判据没量到（status 为 unobservable 时）。 */
  unobservableReason?: string;
  infraError?: boolean; // model/network failure (not a real test failure) — excluded from flake/gate
  /** Structured classification of the failure: code + attribution (docs/archive/spec/06). */
  failure?: Failure;
  /**
   * 这次注入的变异体改了几处。
   *
   * `undefined` = 没注变异体；`0` = **注了但没生效**。后者绝不能当成「用例没抓到」
   * ——那是把工具自己的失败伪装成用例集的盲区，会让杀掉率虚低，而虚低的那部分
   * 看起来像真发现。
   */
  mutationApplied?: number;
  /**
   * 判据求值时页面停在哪。
   *
   * 有它才分得清**判错**和**没走到**：一条声称覆盖 `/owners/find->/owners` 的用例，
   * 如果最后停在 `/owners/find`，那它根本没到过要验的那一屏——
   * 它的「失败」是**执行没走到**，不是「产品和期望不符」。
   *
   * xUnit 里这两件事叫 failure 与 error，分得清清楚楚；而我们此前只有一个 failed，
   * 于是在算精确率时把「没走到」全算成了用例虚报——**那会系统性地低估精确率，
   * 而低估的那部分看起来像用例写得差**。
   */
  endedAt?: string;
}

/**
 * What the page shows, as text and address.
 *
 * `innerText` rather than the DOM tree on purpose: a text case is end-agnostic, so the only
 * thing it can honestly refer to is what a person would read on the screen. No selectors
 * get invented here, and none leak into stage-one artifacts.
 */
async function snapshotPage(page: { evaluate: (fn: () => unknown) => Promise<unknown>; url: () => string }): Promise<PageSnapshot> {
  const capturedAt = Date.now();
  const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string;
  return { text: String(text ?? ""), url: page.url(), capturedAt };
}

export async function executeRun(
  url: string,
  steps: string[],
  expected: string,
  opts: {
    signal?: AbortSignal;
    captureObservations?: boolean;
    preparation?: Preparation;
    modelBudget?: RoleProxyBudget;
    executorModel?: RoleModelConnection;
    injected?: boolean;
    wallet?: boolean;
    rpcUrl?: string;
    chainId?: number;
    cacheId?: string;
    pageVersion?: string;
    /**
     * 批次级浏览器复用（07 T-28）：同 key 的连续运行共用一个浏览器，登录态只在第一次跑。
     * 复用时这一条从 `page.goto(url)` 开始、换自己的 agent（cacheId 按用例）；带变异体的运行不进池。
     * 谁给的 key 谁负责 `releaseRunSession(key)`——批次结束时。
     */
    sessionKey?: string;
    authentication?: AuthenticationChecks;
    login?: string[]; // login-flow step templates (登录态), run before case steps
    postSteps?: string[]; // teardown/cleanup step templates, run after the assert
    resolve?: ResolveContext; // ${env.*}/${secret.*} resolution context
    rowLabel?: string; // data-driven row label, logged for forensics
    extraHeaders?: Record<string, string>; // fixed request headers (resolved)
    query?: Record<string, string>; // fixed query-string params
    storageState?: StorageState | null; // captured login state to inject
    /** 持续登录的 SUT profile 目录。给了它就用它启动、不注入 storageState。见 session.ts。 */
    sutProfileDir?: string;
    /**
     * 这个被测对象要多大的视口。跟着环境走，不给就用默认的 1024×720——
     * 默认是为压小视觉模型的图定的，把它调大会让所有 SUT 一起变贵。见 U-69。
     */
    viewport?: { width?: number; height?: number };
    /**
     * **定位提示**：探索阶段见过的控件，它的文案与选择器。
     *
     * 探索对每个控件都记了精确选择器，而文本用例按设计是端无关的、只带文案——于是执行时
     * 只能靠视觉模型按文字找控件。在交易页上「Order History」「Balances」这些词在表格行里
     * 也出现，`locate: multiple elements found, length = 13` 就是这么来的（docs/v3/history/23 F-15）。
     *
     * 提示**不是权威**。缓存的 xpath 会随 DOM 过时，直接照点就会点错东西——所以这里要求
     * 两件事同时成立才用它：选择器**恰好命中一个**元素，且那个元素的可见文本**仍然包含**
     * 当初记下的文案。任何一条不成立就原样交回模型，只在日志里留一行。
     * 少一次模型调用是附带的好处，不是目的；目的是让「这个词在页面上出现十三次」不再是失败。
     */
    locators?: LocatorHint[];
    /**
     * A check a program can settle. When present it decides the case and the model is
     * never asked — which is what makes a tier-1 label mean something at execution time.
     */
    oracle?: MachineOracle;
    /**
     * **判据也可以挂在断言上**（v2 的 `assertions[]`）。
     *
     * 2026-09-13 实测（exec-1a32f697）：一次跑 10 条，10 条全是 `tier 1`、全都声明了
     * `text`/`noText` 判据，而**实际判决 10 条全是 `judge`**——一条机器判据都没执行。
     * 原因是这里只收一个顶层 `oracle`，而 v2 把 `expected` 一句话拆成了 `assertions[]`、
     * 判据挂在每条断言上：整份 81 条里**顶层 `oracle` 是 0 条**，48 条的判据全在断言上，
     * 一共 101 条（text 85 · noText 11 · count 4 · delta 1）被原地扔掉。
     *
     * 门禁当时跟着 v2 改过（`oracles = [c.oracle, ...assertions.map(a => a.oracle)]`），
     * 执行侧没跟上。后果不只是多花一次模型调用：TC-017 的失败就是判官在纠结
     * 「% 控件算不算在 Size 输入框『旁边』」——而一条 `{kind:"text",value:"%"}`
     * 根本不会有这个问题。**声明了程序能判，就该让程序判。**
     */
    assertions?: Array<{ id?: string; statement: string; oracle?: MachineOracle; afterStep?: number }>;
    /**
     * 变异体：把一个人造缺陷注进这一次执行看到的 DOM，看这条用例会不会叫。
     * 被测应用不动——见 `mutate/inject.ts`。
     */
    mutation?: { id: string; script: string };
    web3?: {
      // dapp run: settle-wait after nav + on-chain assertions checked before/after the steps
      chainAssertions: ChainAssertion[];
      rpcUrl: string;
      account: string;
      settleMs?: number;
    };
  } = {},
): Promise<RunResult> {
  const observer = executionObserver();
  observer.begin("session-navigation");
  const auxiliaryAssertions = opts.preparation?.auxiliaryAssertions ?? [];
  const auxiliaryChecks: NonNullable<RunResult["auxiliaryChecks"]> = [];
  const injected = !!opts.injected;
  const wallet = !injected && !!opts.wallet;
  const ctx: ResolveContext = opts.resolve ?? { env: {}, secrets: {} };
  const secretVals = Object.values(ctx.secrets);
  const rlog = (s: string) => logs.push(redact(s, secretVals));
  const startedAt = new Date().toISOString();
  const sinceMs = Date.now();
  const t0 = sinceMs;
  const logs: string[] = [];
  const observations: NonNullable<RunResult["observations"]> = [];
  const prerequisiteChecks: NonNullable<RunResult["prerequisiteChecks"]> = [];
  const environmentFacts: EnvironmentFact[] = [];
  const recipeChecks: NonNullable<RunResult["recipeChecks"]> = [];
  const observe = async (step:number) => { if(opts.captureObservations && session){const snap=await snapshotPage(session.page); observations.push({step,text:redact(snap.text,secretVals).slice(0,24000),url:redact(snap.url??"",secretVals),capturedAt:snap.capturedAt??Date.now()});} };
  /** 六段计时：`mark()` 把上一段收口。段与段之间没有缝——它们加起来就是 durationMs。 */
  const phases: RunPhases = { launchMs: 0, loginMs: 0, settleMs: 0, stepsMs: 0, assertMs: 0, teardownMs: 0 };
  const PHASE_ORDER: (keyof RunPhases)[] = ["launchMs", "loginMs", "settleMs", "stepsMs", "assertMs", "teardownMs"];
  let phaseT = t0;
  /** 现在开着的是哪一段。出错时把剩下的时间记到它头上——按「哪段还是 0」猜会猜错（复用会话时登录态本来就是 0）。 */
  let open: keyof RunPhases = "launchMs";
  const mark = (k: keyof RunPhases) => {
    const now = Date.now();
    phases[k] += now - phaseT;
    phaseT = now;
    open = PHASE_ORDER[Math.min(PHASE_ORDER.indexOf(k) + 1, PHASE_ORDER.length - 1)];
  };
  /** 变异体改了几处。`undefined` = 这次没注变异体；`0` = 注了但没生效。 */
  let mutationApplied: number | undefined;
  /** 判据求值时页面停在哪——用来分辨「判错」和「没走到」。 */
  let endedAt: string | undefined;
  const screenshots: string[] = [];
  const pngBuffers: Buffer[] = [];
  const modelRequests: RoleRequestRecord[] = []; let requestSource: RoleRequestRecord[] | undefined, requestOffset = 0;
  let result: RunResult | undefined;
  let session: Awaited<ReturnType<typeof launchSession>> | undefined;
  let stopApprover: (() => void) | undefined;
  /** 变异体改过这份 DOM，绝不能进池让下一条接着用。 */
  const poolKey = opts.sessionKey && !opts.mutation ? opts.sessionKey : undefined;
  let reused = false;
  const checkCancelled = () => { if (opts.signal?.aborted) throw new Error("EXEC_CANCELLED"); };
  const abortSession = () => { if (poolKey) void evictSession(poolKey).catch(() => {}); else void session?.cleanup().catch(() => {}); };
  /**
   * 一步文本怎么执行：`waitFor:` 开头的是等待（`aiWaitFor`，看到为止，最多 30 秒），其余是动作。
   * 登录态第一步「等 5 秒」曾经不够——Enable Trading 还没渲染出来，缓存的 xpath 解析不到，
   * Midscene 回放拿 undefined 坐标点鼠标（`06 §6.1`）。等一个明确的东西，不等一个数字。
   */
  /**
   * 这一步能不能直接用探索记下的选择器点掉。返回 false 就交回模型。
   * 只处理**点击**：填值、断言、滚动都还是模型的事。
   */
  const byLocator = async (t: string): Promise<boolean> => {
    const hit = pickLocator(t, opts.locators ?? []);
    if (!hit) return false;
    try {
      // Puppeteer，不是 Playwright：这里没有 locator().count()，用 $$ 取全部匹配。
      const page = session!.page as unknown as {
        $$(s: string): Promise<Array<{ click(): Promise<void> }>>;
        evaluate<T, A>(fn: (el: A) => T, arg: A): Promise<T>;
      };
      const els = await page.$$(hit.selector);
      const text = els.length === 1 ? await page.evaluate((el) => (el as unknown as HTMLElement).innerText ?? "", els[0]!) : "";
      const verdict = locatorUsable(hit.label, els.length, text);
      if (!verdict.ok) { rlog(`  定位提示${verdict.why}（${hit.label}），交回模型`); return false; }
      await els[0]!.click();
      rlog(`  定位提示命中：${hit.label}`);
      return true;
    } catch (e) {
      rlog(`  定位提示用不了（${hit.label}：${String((e as Error).message).slice(0, 60)}），交回模型`);
      return false;
    }
  };
  const act = async (t: string) => {
    checkCancelled();
    if (t.startsWith("waitFor:")) return session!.agent.aiWaitFor(t.slice("waitFor:".length).trim(), { timeoutMs: 30_000 });
    // 纯导航步骤直接跳转——交给 aiAction 会被规划成 Midscene 没有的 `Navigate` 动作（见 stepSemantics.ts）。
    const navTo = navigationTarget(t, session!.page.url());
    if (navTo) {
      rlog(`  直接跳转（纯导航步骤，不交给模型）：${navTo}`);
      await session!.page.goto(navTo, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => session!.page.goto(navTo, { waitUntil: "domcontentloaded", timeout: 45000 }));
      await settleOn(session!.page, { minMs: 600, maxMs: 12_000 });
      return;
    }
    if (await byLocator(t)) return;
    try {
      await session!.agent.aiAction(t);
    } catch (e) {
      /**
       * Midscene 0.30.10 回放 bug（06 §6.1）：缓存的 yaml 流程里 locate 失效、模型重定位并写回缓存之后，
       * 这一次仍拿 undefined 坐标去点，`dispatchMouseEvent … params.x: double value expected`。
       * 缓存此时已经是新的，同一步再放一遍就过——重试一次，不重试第二次。
       */
      if (!/dispatchMouseEvent.*double value expected/.test((e as Error).message)) throw e;
      observer.retry("coordinate-replay");
      rlog(`  回放坐标丢失（Midscene 缓存刷新后的第一次），这一步重试一次`);
      await session!.agent.aiAction(t);
    }
  };
  const shot = async () => {
    const png = Buffer.from(await session!.page.screenshot({ type: "png" }));
    pngBuffers.push(png);
    screenshots.push(`data:image/png;base64,${png.toString("base64")}`);
  };
  try {
    checkCancelled();
    opts.signal?.addEventListener("abort", abortSession, { once: true });
    if (opts.rowLabel) rlog(`data row ${opts.rowLabel}`);
    logs.push(`navigate → ${url}${injected ? " (injected wallet)" : wallet ? " (with MetaMask)" : ""}`);
    const dataOpts = {
      signal: opts.signal, modelBudget: opts.modelBudget,
      cacheContext: cacheDigest({url,steps,expected,oracle:opts.oracle??null,postSteps:opts.postSteps??[],login:opts.login??[],resolve:opts.resolve??null,headers:opts.extraHeaders??null,query:opts.query??null,viewport:opts.viewport??null,pageVersion:opts.pageVersion??null}),
      executorModel: opts.executorModel ?? executorConnectionFromEnv(),
      extraHeaders: opts.extraHeaders,
      query: opts.query,
      // profile 自带登录态时不再注入 storageState——两条路只走一条，避免半套会话打架。
      storageState: opts.sutProfileDir ? null : opts.storageState,
      sutProfileDir: opts.sutProfileDir,
      mutation: opts.mutation,
      ...(opts.viewport ? { viewport: opts.viewport } : {}),
    };
    const launchOpts = injected
      ? { injected: true, rpcUrl: opts.rpcUrl, chainId: opts.chainId, cacheId: opts.cacheId, ...dataOpts }
      : { wallet, cacheId: opts.cacheId, ...dataOpts };
    // 池的指纹：什么都一样才算同一个浏览器能接着用。storageState/cacheId 不进指纹——前者复用时本来就在浏览器里，后者按用例换 agent。
    const modelFingerprint = createHash("sha256").update(JSON.stringify(dataOpts.executorModel)).digest("hex");
    // loggedIn 进指纹：复用会话会跳过登录，一条从未登录开始的用例不能接一个已登录的浏览器，反之亦然。
    const fingerprint = JSON.stringify({ url, injected, wallet, rpcUrl: opts.rpcUrl, chainId: opts.chainId, viewport: opts.viewport, sutProfileDir: opts.sutProfileDir, extraHeaders: opts.extraHeaders, query: opts.query, modelFingerprint, modelBudget: opts.modelBudget, loggedIn: (opts.login?.length ?? 0) > 0 || !!opts.storageState });
    if (poolKey) {
      const got = await acquireSession(poolKey, fingerprint, () => launchSession(url, launchOpts), (sess) => sess.cleanup());
      session = got.session;
      requestOffset = session.modelRequests?.length ?? 0;
      reused = got.reused;
      requestSource = session.modelRequests;
      observer.source(() => requestSource, requestOffset);
      observer.data.cache.session = reused ? "hit" : "miss";
      if (reused) {
        // 回到起点：同一个浏览器、**新的页面**、这条用例自己的 agent（cacheId 按用例）。登录态在浏览器里，不用再跑。
        session = await reopenPage(session, url, launchOpts);
        replaceSession(poolKey, session);
        logs.push(`session reused (key ${poolKey}, use #${got.uses}) — login flow skipped`);
      }
    } else {
      session = await launchSession(url, launchOpts);
    }
    requestSource = session.modelRequests;
    observer.source(() => requestSource, requestOffset);
    if (opts.signal?.aborted) { abortSession(); checkCancelled(); }
    if (injected) logs.push(`injected wallet ${session.injectedAddress}`);
    else if (wallet && session.walletId) {
      stopApprover = startPopupApprover(session.browser);
      logs.push(`wallet ready (unlocked=${session.walletUnlocked})`);
    }
    await shot();
    mark("launchMs");
    observer.begin("authentication");
    // Login flow (登录态): resolve ${secret.*}/${env.*} for execution, but log the
    // TEMPLATE text so credentials never appear in logs/reports.
    await settleOn(session.page,{minMs:600,maxMs:12_000});
    const verifyAuthentication = async () => authenticationState(opts.authentication ?? {}, {
      url: session!.page.url(),
      labels: await session!.page.evaluate(() => (document.body?.innerText ?? "").split(/\n/).map(s=>s.trim()).filter(Boolean)),
      address: session!.injectedAddress, receipts: session!.signatureReceipts ?? [],
    });
    const verified = await verifyAuthentication();
    const restored = reused || !!opts.storageState || !!opts.sutProfileDir;
    rlog(verified === true ? 'authentication verified; skipping login' : verified === false ? 'authentication check failed; attempting configured login' : 'authentication unverified: no checks configured');
    const login = shouldRunLogin(verified, restored, !!opts.login?.length) ? opts.login! : [];
    if (login.length) {
      rlog(`login flow (${login.length} steps)`);
      for (const t of login) {
        rlog(`  login: ${t}`);
        const step = resolveText(t, ctx);
        if (step.startsWith("waitFor:")) await withModel(() => session!.agent.aiWaitFor(step.slice(8), {timeoutMs:30_000}));
        else await withModel(() => act(step));
      }
      await shot();
      /**
       * 登录态跑完再回一次起点（07 T-28）。批次里复用会话的用例都是从 `goto` 之后的页面开始的；
       * 第一条却是从「登录态刚点完」的页面开始——两种起点的 DOM 兄弟序号不一样，Midscene 存的
       * 绝对 xpath 就对不上（实测：一半用例在新浏览器里记的缓存，到复用会话里失效 18 次）。
       * 起点只能有一个：登录态之后的、网络安静下来的那一页。
       */
      await session.page.goto(url, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => session!.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }));
    }
    mark("loginMs");
    observer.begin("preparation");
    const ready=await settleOn(session.page,{minMs:600,maxMs:12_000});
    checkCancelled();
    if(!ready.settled&&ready.controls===0&&ready.textLen===0)throw new Error('PAGE_NOT_READY: the target page remained blank before execution');
    rlog(`page ready after ${ready.ms}ms (${ready.controls} controls, ${ready.textLen} text characters)`);
    if (!opts.preparation && await verifyAuthentication() === false) throw new Error('AUTHENTICATION_NOT_VERIFIED: configured login checks failed before case execution');
    await observe(0);
    if(opts.captureObservations||opts.preparation)await shot();
    const refreshFacts = async () => {
      const capturedAt = Date.now();
      environmentFacts.length = 0;
      environmentFacts.push(
        {fact:'target-origin', value:new URL(session!.page.url()).origin, source:'browser:current-url', capturedAt},
        {fact:'injected-wallet', value:!!session!.injectedAddress, source:'runner:provider-installation', capturedAt},
        {fact:'injected-account', value:session!.injectedAddress, source:'runner:provider-installation', capturedAt},
        {fact:'injected-chain', value:session!.injectedChainId, source:'runner:provider-installation', capturedAt},
        {fact:'authentication', value:await verifyAuthentication(), source:'runner:configured-session-checks', capturedAt},
      );
    };
    await refreshFacts();
    const recipeCheck = async (phase:'entry'|'postcondition') => {
      for(const check of (phase==='entry' ? opts.preparation?.recipe?.entryChecks : opts.preparation?.recipe?.postconditions) ?? []) {
        const receipt = await checkPrerequisite(check, {
          facts:environmentFacts, snapshot:()=>snapshotPage(session!.page),
          assert:async text=>{await withModel(()=>session!.agent.aiAssert(text));},
          resolve:text=>resolveText(text,ctx), redact:text=>redact(text,secretVals),
        });
        recipeChecks.push({...receipt,phase});
        if(receipt.status!=='pass')throw new Error(`PREREQUISITE_NOT_VERIFIED: recipe ${phase}: ${receipt.statement}: ${receipt.detail}`);
      }
    };
    await recipeCheck('entry');
    // Preparation checks happen in this browser, before any business test step.
    for (const [i, step] of (opts.preparation?.steps ?? []).entries()) {
      rlog(`prepare ${i+1}: ${step}`);
      await withModel(() => act(resolveText(step,ctx)));
      await shot(); await observe(-(i+1));
    }
    await refreshFacts();
    await recipeCheck('postcondition');
    if (await verifyAuthentication() === false) throw new Error('AUTHENTICATION_NOT_VERIFIED: configured login checks failed after preparation');
    for (const check of opts.preparation?.checks ?? []) {
      // Legacy frozen packages retain their original visual-check implementation.
      const contract = typeof check === 'string' ? {statement:check, checks:[{kind:'screen' as const, statement:check}]} : check;
      const receipt = await checkPrerequisite(contract, {
        facts:environmentFacts, snapshot:()=>snapshotPage(session!.page),
        assert:async text=>{await withModel(()=>session!.agent.aiAssert(text));},
        resolve:text=>resolveText(text,ctx), redact:text=>redact(text,secretVals),
      });
      prerequisiteChecks.push(receipt);
      rlog(`prerequisite ${receipt.status}: ${receipt.statement} — ${receipt.detail}`);
      if (receipt.status !== 'pass') {
        await shot(); await observe(-999);
        throw new Error(`PREREQUISITE_NOT_VERIFIED: ${receipt.statement}: ${receipt.detail}`);
      }
    }
    // Dapp/SPA settle: give the app time to detect the injected wallet + render before we
    // act/assert (a bare domcontentloaded fires before a React dapp is interactive).
    if (opts.web3) {
      await new Promise((r) => setTimeout(r, opts.web3!.settleMs ?? 4000));
    }
    /**
     * 这一次要机器判的东西：顶层那条（老路径），加上每条自带判据的断言（v2 路径）。
     * 见 `opts.assertions` 上的注释——不收它，声明的 tier 1 在执行时就是一个标签。
     * 在步骤**之前**算出来：「前」读数取不取，取决于这份清单里有没有关系型判据。
     */
    /**
     * 挂在某一步之后判的断言（`afterStep`，从 1 数）。它们在步骤循环里当场判，不进最后那一轮。
     * api 判据要前后读接口，仍放到最后判。
     */
    const stepBound = (a: { oracle?: MachineOracle; afterStep?: number }) =>
      a.afterStep !== undefined && a.afterStep >= 1 && a.afterStep <= steps.length && a.oracle?.kind !== "api";
    const machineChecks: Array<{ statement: string; oracle: MachineOracle }> = [
      ...(opts.oracle && opts.oracle.kind !== "none" ? [{ statement: expected || describeOracle(opts.oracle), oracle: opts.oracle }] : []),
      ...(opts.assertions ?? []).flatMap((a) => (a.oracle && a.oracle.kind !== "none" && !stepBound(a) && !isOpenQuestion(a.statement) ? [{ statement: a.statement, oracle: a.oracle }] : [])),
    ];
    /**
     * 「前」读数一律取，不再只为 `delta` 取。
     *
     * 两个理由。一是我 2026-09-13 把判据扩到 `assertions[]` 时带进去的洞：
     * 原来只看 `opts.oracle?.kind === "delta"`，而 delta 现在可以挂在断言上——那样就**拿不到前读数**。
     * 二是它能白捡一个判断：**这条判据在什么都没操作的时候是不是就已经成立了**。
     *
     * 2026-09-13 实测 `trade-panel.order-entry` 10 条：**6 条的判据在初始页面上就成立**。
     * 最刺眼的是 TC-011「默认方向为 Buy / Long，切换到 Sell / Short」，判据是
     * `text:"Sell / Short"`——而同一模块的 TC-013 这条用例的全部内容就是证明
     * 「两个方向按钮始终都在」。**TC-011 拿一条已知恒为真的事实，去证明一次切换发生了：
     * 它永远会绿，哪怕切换功能整个坏掉。**
     *
     * 这里不改判决——判据成立就是成立。只把它记下来（`heldBefore`），
     * 让报告能说出「这条绿是免费的」。一次 `page.evaluate`，不花模型调用。
     */
    let snapBefore: PageSnapshot | undefined;
    if (machineChecks.length || auxiliaryAssertions.some(a=>a.oracle) || (opts.assertions ?? []).some((a) => a.oracle && stepBound(a))) snapBefore = await snapshotPage(session.page);
    // 接口判据的「前」读数：只有关系型判据需要（increased/decreased/unchanged）。
    // 步骤前不等 settleMs——那是给「后」读数留的传播时间。
    for (const { oracle: o } of machineChecks) {
      if (o.kind !== "api" || !["increased", "decreased", "unchanged"].includes(o.op)) continue;
      const api = await observeApi({ ...o, settleMs: 0 }, ctx);
      snapBefore = { text: snapBefore?.text ?? "", url: session.page.url(), api };
      rlog(`api snapshot (before) — ${o.path} = ${api.error ?? JSON.stringify(api.value)}`);
    }
    // On-chain snapshot BEFORE the steps, so balance-delta assertions measure their effect.
    let chainBefore: bigint[] = [];
    if (opts.web3?.chainAssertions?.length) {
      chainBefore = await snapshotBalances(opts.web3.rpcUrl, opts.web3.chainAssertions, opts.web3.account);
      rlog(`chain snapshot (before) — ${chainBefore.length} balance(s)`);
    }
    mark("settleMs");
    observer.begin("actions");
    // Functional oracle: verify the case's expected outcome and record it structurally.
    const oracle: OracleCheck[] = [];
    let assertFailed: string | undefined;
    let unobservable: string | undefined;
    let infraError = false;
    /**
     * 在第 n 步之后当场判一条断言：机器判据取此刻的快照，没有判据的交给判官，开放问题只记不判。
     * 2026-09-15 Vikunja：两条描述「途经那一屏」的断言在最后一步之后判，页面早已换了，恒红。
     */
    /**
     * judge 判据：在这份快照上采样，结果塞进 `snap.judge`，再交给 `evaluateOracle` 统一出判决。
     * 全部采样都栽在环境上时，这条判据根本没被判过：记 infra，返回 false 让调用方跳过它。
     */
    const judgeInto = async (snap: PageSnapshot, o: Extract<MachineOracle, { kind: "judge" }>): Promise<boolean> => {
      const out = await sampleJudge(session!.agent as never, o, {
        call: (fn) => withModel(fn), resolve: (t) => resolveText(t, ctx), isInfra: isInfraError, log: rlog,
      });
      if (out.infra) {
        infraError = true;
        assertFailed = redact(out.infraMessage ?? "judge sampling failed", secretVals);
        rlog(`assert ⚠ infra error (judge) — ${assertFailed.slice(0, 80)}`);
        return false;
      }
      snap.judge = out.sampling;
      return true;
    };
    const checkNowInner = async (a: { statement: string; oracle?: MachineOracle }, n: number) => {
      if (isOpenQuestion(a.statement)) {
        oracle.push({ assertion: a.statement, status: "unobservable", detail: "开放问题：记下，不下判决" });
        rlog(`assert ∅ (after step ${n}) 开放问题——不判`);
        return;
      }
      if (a.oracle && a.oracle.kind !== "none") {
        const snap = await snapshotPage(session!.page);
        if (a.oracle.kind === "judge" && !(await judgeInto(snap, a.oracle))) return;
        const verdict = evaluateOracle(a.oracle, snap, snapBefore);
        const detail = redact(verdict.detail, secretVals);
        oracle.push({ assertion: a.statement, status: verdict.status, detail, decidedBy: a.oracle.kind === "judge" ? "judge" : "machine",
          ...(verdict.judge ? { judge: verdict.judge } : {}) });
        if (verdict.status === "fail") assertFailed = detail;
        else if (verdict.status === "unobservable" && !unobservable) unobservable = detail;
        rlog(`assert ${verdict.status === "pass" ? "✓" : verdict.status === "unobservable" ? "∅" : "✗"} (after step ${n}) — ${detail}`);
        return;
      }
      rlog(`assert (judge, after step ${n}): ${a.statement}`);
      try {
        await withModel(() => session!.agent.aiAssert(resolveText(a.statement, ctx)));
        oracle.push({ assertion: a.statement, status: "pass", decidedBy: "judge" });
      } catch (e) {
        const detail = redact((e as Error).message, secretVals);
        if (isInfraError(detail)) { infraError = true; assertFailed = detail; }
        else { oracle.push({ assertion: a.statement, status: "fail", detail, decidedBy: "judge" }); assertFailed = detail; }
      }
    };
    const checkNow = async (a: { statement: string; oracle?: MachineOracle }, n: number) => {
      observer.begin("assertions");
      const before = oracle.length;
      try { await checkNowInner(a,n); }
      finally {
        const checks = oracle.slice(before);
        if (checks.some(c=>c.status==='fail') || infraError) observer.issue('failed', {attribution:infraError?'infra':'assert',retryable:infraError});
        else if(checks.some(c=>c.status==='unobservable')) observer.issue('unknown');
      }
    };
    const checkAuxiliary = async (a:typeof auxiliaryAssertions[number], step:number) => {
      const offset=oracle.length;
      await checkNow(a,step);
      auxiliaryChecks.push(...oracle.splice(offset).map(check=>({...check,id:a.id,supports:a.supports})));
    };
    for (const [i, step] of steps.entries()) {
      observer.begin("actions");
      rlog(`step ${i + 1}: ${step}`);
      await withModel(() => act(resolveText(step, ctx)));
      await shot(); await observe(i+1);
      for (const a of (opts.assertions ?? []).filter((x) => stepBound(x) && x.afterStep === i + 1)) await checkNow(a, i + 1);
      for (const a of auxiliaryAssertions.filter(x=>x.afterStep===i+1)) await checkAuxiliary(a,i+1);
    }
    mark("stepsMs");
    observer.begin("assertions");
    /**
     * **变异体到底生效了没有，必须读回来——而且要在步骤跑完之后读。**
     *
     * 注入脚本用 `MutationObserver` 随页面变化持续应用。第一版在会话刚启动时就读，
     * 那时页面还在入口页，像「has not been found」这种**提交表单之后才出现**的文字
     * 一处都没改到——于是三个变异体全被记成「没生效」，而它们其实一次都没有机会生效。
     *
     * 那一次实验因此什么都没测出来。但它也证明了三分类是对的：如果把「没生效」
     * 混进「活下来」，报告会写成「杀掉率 0.000，发现 3 个盲区」——一个完全虚假的结论。
     */
    if (opts.mutation) {
      const applied = await (session.page as unknown as {
        evaluate<T>(fn: () => T): Promise<T>;
      })
        .evaluate(() => (window as unknown as { __tpMutation?: { applied?: number } }).__tpMutation?.applied ?? 0)
        .catch(() => 0);
      mutationApplied = applied;
      rlog(`变异体 ${opts.mutation.id}：改了 ${applied} 处${applied ? "" : "——没生效，这一次不算数"}`);
    }
    // A machine-checkable oracle decides on its own and costs no model call. The judge is
    // the fallback, not the default: a case that says a program can settle it should be
    // settled by one, or the tier it carries is decoration.
    // 「后」快照只取一次，N 条判据在同一份快照上判：不会各判各的页面。
    if (machineChecks.length) {
      const snapAfter = await snapshotPage(session.page);
      for (const check of machineChecks) if (check.oracle.kind === "api") {
        snapAfter.api = await observeApi(check.oracle, ctx);
        rlog(`api snapshot (after) — ${check.oracle.path} = ${snapAfter.api.error ?? JSON.stringify(snapAfter.api.value)}`);
      }
      endedAt = snapAfter.url;
      for (const check of machineChecks) {
      const shown = describeOracle(check.oracle);
      rlog(`assert (${check.oracle.kind === "judge" ? "judge" : "machine"}): ${shown}`);
      if (check.oracle.kind === "judge") {
        snapAfter.judge = undefined;
        if (!(await judgeInto(snapAfter, check.oracle))) continue;
      }
      const verdict = evaluateOracle(check.oracle, snapAfter, snapBefore);
      /**
       * **判据的 detail 也要抹密钥。**
       *
       * 判官那一档一直在抹（下面那个分支的 `redact((e as Error).message, secretVals)`），
       * 机器判据这一档没有——而它恰恰是被鼓励用的那一档（层级要有事实撑着，见门禁的
       * `tier-unbacked`）。
       *
       * 漏的路径很具体：`evaluateOracle` 的 url 分支原样吐出 `地址 ${after.url}`
       * （`oracle.ts`），而查询串里可能带着令牌。那句话进 `runs.oracleJson`、
       * 进 `runs.failureReason`、再渲染到界面上——**而同一个字符串的 `rlog` 副本是抹过的**。
       * 一份抹过、一份没抹，比两份都没抹更难发现。
       */
      const detail = redact(verdict.detail, secretVals);
      /**
       * 这条判据在**步骤跑之前**是不是就已经成立了。关系型判据（delta/api 的增减）
       * 天然要比较前后，问这个没有意义，所以只问「一份快照就能判」的那几种。
       */
      const heldBefore = snapBefore && ["text", "noText", "count"].includes(check.oracle.kind)
        ? evaluateOracle(check.oracle, snapBefore).status === "pass" : undefined;
      oracle.push({
        assertion: check.statement || shown,
        status: verdict.status,
        detail,
        decidedBy: check.oracle.kind === "judge" ? "judge" : "machine",
        ...(heldBefore === undefined ? {} : { heldBefore }),
        ...(verdict.judge ? { judge: verdict.judge } : {}),
      });
      if (heldBefore && verdict.status === "pass")
        rlog(`  ⚠ 这条判据在步骤跑之前就已经成立——这次通过没有证明这些步骤做成了什么`);
      // 一条判据不过就是这条用例不过；后面的仍然判完，报告里要看得见是哪几条不过。
      if (verdict.status === "fail") assertFailed = detail;
      else if (verdict.status === "unobservable" && !unobservable) unobservable = detail;
      rlog(`assert ${verdict.status === "pass" ? "✓" : verdict.status === "unobservable" ? "∅" : "✗"} — ${detail}`);
      }
      /**
       * 没带判据的断言仍然交给判官——按**这一条**判，不是拿 `expected` 那句总结代替。
       * 81 条里只有 1 条是这种「一半有一半没有」，所以这条路很少走。
       */
      // Explicit none has the same screen-judge semantics as an omitted oracle.
      // Keep the original approved artifact intact; dispatch it here, never auto-pass it.
      for (const a of [...(opts.oracle?.kind === "none" && expected ? [{statement:expected}] : []), ...(opts.assertions ?? [])] as Array<{statement:string;oracle?:MachineOracle;afterStep?:number}>) {
        if ((a.oracle && a.oracle.kind !== "none") || stepBound(a)) continue;
        // 作者明说「不作为失败判据」的，不交给判官（stepSemantics.ts 的 isOpenQuestion）。
        if (isOpenQuestion(a.statement)) {
          oracle.push({ assertion: a.statement, status: "unobservable", detail: "开放问题：记下，不下判决" });
          rlog(`assert ∅ 开放问题——不判：${a.statement.slice(0, 60)}`);
          continue;
        }
        rlog(`assert (judge): ${a.statement}`);
        try {
          await withModel(() => session!.agent.aiAssert(resolveText(a.statement, ctx)));
          oracle.push({ assertion: a.statement, status: "pass", decidedBy: "judge" });
        } catch (e) {
          const detail = redact((e as Error).message, secretVals);
          if (isInfraError(detail)) { infraError = true; assertFailed = detail; rlog(`assert ⚠ infra error — ${detail.slice(0, 80)}`); }
          else { oracle.push({ assertion: a.statement, status: "fail", detail, decidedBy: "judge" }); assertFailed = detail; rlog(`assert ✗ — ${detail}`); }
        }
      }
    } else if (expected) {
      rlog(`assert: ${expected}`);
      try {
        await withModel(() => session!.agent.aiAssert(resolveText(expected, ctx)));
        oracle.push({ assertion: expected, status: "pass", decidedBy: "judge" });
        logs.push("assert ✓");
      } catch (e) {
        const detail = redact((e as Error).message, secretVals);
        if (isInfraError(detail)) {
          // Model/network failure during the assert — we never actually evaluated the
          // oracle, so don't record a functional fail. Flag it as an infra error.
          infraError = true;
          assertFailed = detail;
          rlog(`assert ⚠ infra error (not a test failure) — ${detail.slice(0, 80)}`);
        } else {
          oracle.push({ assertion: expected, status: "fail", detail, decidedBy: "judge" });
          rlog(`assert ✗ — ${detail}`);
          assertFailed = detail;
        }
      }
    }
    // Pure visual cases still need every reviewed assertion, not only the summary.
    if(!machineChecks.length)for(const a of opts.assertions??[])if(!stepBound(a))await checkNow(a,steps.length);
    for (const a of auxiliaryAssertions.filter(x=>!x.afterStep)) await checkAuxiliary(a,steps.length);
    if(auxiliaryChecks.some(c=>c.status!=='pass'))assertFailed='AUXILIARY_CHECK_NOT_VERIFIED: '+auxiliaryChecks.filter(c=>c.status!=='pass').map(c=>`${c.id}: ${c.detail??c.assertion}`).join('; ');
    // On-chain oracle: read the chain AFTER the steps and evaluate each assertion. These
    // join the same oracle array (so they show + gate the verdict) — verifies real state,
    // not just the UI. Snapshot before teardown so cleanup doesn't skew it.
    if (opts.web3?.chainAssertions?.length) {
      try {
        const after = await snapshotBalances(opts.web3.rpcUrl, opts.web3.chainAssertions, opts.web3.account);
        // If any assertion checks "the wallet sent a tx", poll receipts for the hashes our
        // injected wallet recorded this run (from the actual UI interaction — we ARE the wallet).
        const needsTx = opts.web3.chainAssertions.some((a) => a.kind === "txSubmitted");
        const sent = session.sentTxs ?? [];
        if (needsTx) rlog(`wallet sent ${sent.length} tx(s) this run — polling receipts`);
        const receipts = needsTx ? await collectReceipts(opts.web3.rpcUrl, sent, 30000) : [];
        opts.web3.chainAssertions.forEach((a, i) => {
          const r =
            a.kind === "txSubmitted"
              ? evalTxSubmitted(a, receipts)
              : evalChainAssertion(a, chainBefore[i] ?? 0n, after[i] ?? 0n);
          oracle.push(r);
          rlog(`chain ${r.status === "pass" ? "✓" : "✗"} ${r.assertion} — ${r.detail}`);
          if (r.status === "fail") assertFailed = assertFailed || `chain assertion: ${r.assertion}`;
        });
      } catch (e) {
        rlog(`chain assertions skipped — ${redact((e as Error).message, secretVals).slice(0, 70)}`);
      }
    }
    if (assertFailed) observer.issue("failed", classifyFailure(assertFailed));
    else if (unobservable) observer.issue("unknown");
    mark("assertMs");
    observer.begin("cleanup");
    // Required cleanup is part of reproducibility: a failure cannot leave the run green.
    for (const t of opts.postSteps ?? []) {
      try {
        rlog(`teardown: ${t}`);
        await withModel(() => act(resolveText(t, ctx)));
      } catch (e) {
        observer.issue(opts.signal?.aborted ? "cancelled" : "failed", {attribution:"infra",retryable:false});
        infraError = true;
        assertFailed = assertFailed || "ENV_TEARDOWN_FAILED";
        rlog(`ENV_TEARDOWN_FAILED — ${redact((e as Error).message, secretVals).slice(0, 70)}`);
      }
    }
    mark("teardownMs");
    const perfMetrics = await capturePerf(session.page).catch(() => ({}) as PerfMetrics);
    checkCancelled();
    return result = {
      observation: observer.data,
      modelRequests,
      ...(auxiliaryAssertions.length?{auxiliaryChecks}:{}),
      ...(opts.captureObservations?{observations}:{}),
      ...(opts.preparation?{prerequisiteChecks,...(opts.preparation.recipe?{recipeChecks}:{})}:{}),
      ...(opts.captureObservations || opts.preparation ? {environmentFacts:environmentFacts.map(f=>({...f,value:typeof f.value==='string'?redact(f.value,secretVals):f.value}))} : {}),
      phases,
      // 失败压过一切；没失败但有判据没量到，就是「没有判决」，不是通过。
      status: assertFailed ? "failed" : unobservable ? "unobservable" : "passed",
      ...(unobservable && !assertFailed ? { unobservableReason: unobservable } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(mutationApplied === undefined ? {} : { mutationApplied }),
      failure: assertFailed ? classifyFailure(assertFailed) : undefined,
      durationMs: Date.now() - t0,
      startedAt,
      logs,
      screenshots,
      pngBuffers,
      sinceMs,
      perfMetrics,
      oracle,
      failureReason: assertFailed,
      infraError,
    };
  } catch (e) {
    const message = opts.signal?.aborted ? "EXEC_CANCELLED" : redact((e as Error).message, secretVals);
    observer.issue(opts.signal?.aborted ? "cancelled" : [...prerequisiteChecks,...recipeChecks].some(c=>c.status==='unknown') && ![...prerequisiteChecks,...recipeChecks].some(c=>c.status==='fail') ? "unknown" : "failed", classifyFailure(message));
    logs.push(`error: ${message}`);
    await observe(-999).catch(()=>{});
    // 浏览器本身死了才踢出池；用例层面的异常（规划失败、判据没走到）不踢——下一条 goto 回起点就是干净的，
    // 踢掉就要重起浏览器再跑一遍登录态，正是复用要省的那两段。
    if (poolKey && /Target closed|Session closed|Browser has disconnected|Navigating frame was detached|Protocol error \((Target|Browser|Page)\./.test(message)) {
      await evictSession(poolKey);
      session = undefined;
    }
    // 出错那一刻停在哪段就记到哪段。
    phases[open] += Date.now() - phaseT;
    return result = {
      observation: observer.data,
      modelRequests,
      ...(auxiliaryAssertions.length?{auxiliaryChecks}:{}),
      ...(opts.captureObservations?{observations}:{}),
      ...(opts.preparation?{prerequisiteChecks,...(opts.preparation.recipe?{recipeChecks}:{})}:{}),
      ...(opts.captureObservations || opts.preparation ? {environmentFacts:environmentFacts.map(f=>({...f,value:typeof f.value==='string'?redact(f.value,secretVals):f.value}))} : {}),
      phases,
      status: [...prerequisiteChecks,...recipeChecks].some(c=>c.status==='unknown') && ![...prerequisiteChecks,...recipeChecks].some(c=>c.status==='fail') ? "unobservable" : "failed",
      ...([...prerequisiteChecks,...recipeChecks].some(c=>c.status==='unknown') ? {unobservableReason:message} : {}),
      ...(mutationApplied === undefined ? {} : { mutationApplied }),
      durationMs: Date.now() - t0,
      startedAt,
      logs,
      screenshots,
      pngBuffers,
      sinceMs,
      perfMetrics: {},
      oracle: [],
      failureReason: message,
      infraError: isInfraError(message),
      failure: classifyFailure(message),
    };
  } finally {
    opts.signal?.removeEventListener("abort", abortSession);
    stopApprover?.();
    // 进了池的会话留给下一条；释放由给 key 的那一方在批次结束时做。
    observer.end();
    if (!poolKey && session) {
      observer.begin("cleanup");
      try { await session.cleanup(); }
      catch {
        observer.issue("failed", {attribution:"infra",retryable:false});
        if (result) { result.status = "failed"; result.infraError = true; result.failureReason ??= "ENV_TEARDOWN_FAILED"; result.failure ??= classifyFailure("ENV_TEARDOWN_FAILED"); }
      }
    }
    observer.end();
    modelRequests.push(...(requestSource?.slice(requestOffset) ?? []));
    if (result) { result.durationMs = Date.now() - t0; if (!requestSource) delete result.modelRequests; }
  }
}

/** 批次结束：关掉这个 key 下复用的浏览器。没有就返回 false。 */
export const releaseRunSession = (key: string): Promise<boolean> => releaseSession(key);
