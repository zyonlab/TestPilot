import { STRUCTURE_PROBE, cacheDigest, scopedCacheId, structureOf } from './cache.js';
import { visibleContextTree } from './visibleContext.js';
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { PuppeteerAgent } from "@midscene/web/puppeteer";
import {
  WALLET_DIR,
  PROFILE_DIR,
  isWalletInstalled,
  isWalletOnboarded,
  getExtensionId,
  unlockWallet,
} from "./wallet.js";
import { resolveChainConfig, resolveViewport } from "../env.js";
import { setupInjectedWallet } from "./injectedWallet.js";
import type { StorageState, Viewport } from "../types.js";
import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";
import { executorConnectionFromEnv, openRoleProxy, type RoleRequestRecord, type RoleProxyBudget } from "@testpilot/harness-core";
import { midsceneModelConfig } from "./model.js";

// Apply the fixed query params to EVERY navigation (not just the entry URL) via request
// interception: each document/navigation request's URL is rewritten to carry the params, so
// clicks, redirects and form navigations all keep the flag (e.g. ?e2e=1). Only document
// navigation requests are touched — sub-resources (images/xhr) are left alone. Cooperative
// priority + a handled-guard so it coexists with any other interceptor. Midscene itself does
// not intercept, so this is the sole handler in practice.
async function installQueryInterception(
  page: Page,
  query?: Record<string, string>,
): Promise<void> {
  if (!query || !Object.keys(query).length) return;
  try {
    await page.setRequestInterception(true);
  } catch {
    return; // interception unavailable — the entry-URL append still applies
  }
  page.on("request", (req) => {
    try {
      if (typeof req.isInterceptResolutionHandled === "function" && req.isInterceptResolutionHandled())
        return;
      if (req.isNavigationRequest() && req.resourceType() === "document") {
        const u = new URL(req.url());
        let changed = false;
        for (const [k, v] of Object.entries(query)) {
          if (u.searchParams.get(k) !== v) {
            u.searchParams.set(k, v);
            changed = true;
          }
        }
        if (changed) {
          req.continue({ url: u.toString() }, 0);
          return;
        }
      }
      req.continue(undefined, 0);
    } catch {
      try {
        req.continue(undefined, 0);
      } catch {
        /* already resolved by another handler */
      }
    }
  });
}

// Append fixed query params to a navigation URL (e.g. ?e2e=1&feature=x).
function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query || !Object.keys(query).length) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url; // non-absolute URL (about:blank etc.) — leave as-is
  }
}

/**
 * 装变异体。**两条启动路径都要装。**
 *
 * 一个变异体没装上，计数就恒为 0，而报告会说「没生效」。我先后怀疑了读回时机、
 * 怀疑了 API，最后发现是**第一版只写在注入钱包那条分支里**——正常执行走的是另一条。
 * 这个函数存在的唯一理由就是不让那件事再发生一次。
 *
 * 要在第一次导航之前装好，而且要对**每一个新文档**都重新执行：加载后再注入的话
 * 第一屏是原样的，而很多用例第一步就在第一屏上断言。
 *
 * 注入写法试过三种，只有一种成立（见函数体里的表）。教训是：
 * 我最早用 Playwright 的 `addInitScript({ content })` 做 smoke 测试，它收字符串、一次就通，
 * 于是我以为「注入这件事验过了」。**在另一个 API 上验证过，不等于在这个 API 上能用**
 * ——而失败的表现是计数恒为 0，也就是「变异体没生效」，看起来像被测的东西有问题。
 */
async function installMutation(page: Page, opts: LaunchOpts): Promise<void> {
  if (!opts.mutation) return;
  // 传函数 + 在页内 `new Function(src)()` 求值。三种写法实测过，只有这一种成立：
  //   evaluateOnNewDocument(源码字符串)                      → 不执行
  //   CDP Page.addScriptToEvaluateOnNewDocument({ source })  → 不执行
  //   evaluateOnNewDocument((src) => new Function(src)(), s) → **生效**
  await page.evaluateOnNewDocument((src: string) => {
    new Function(src)();
  }, opts.mutation.script);
}

// Fixed headers + captured cookies must be set BEFORE the first navigation.
async function applyPreNav(page: Page, opts: LaunchOpts): Promise<void> {
  if (opts.extraHeaders && Object.keys(opts.extraHeaders).length) {
    await page.setExtraHTTPHeaders(opts.extraHeaders);
  }
  const cookies = opts.storageState?.cookies;
  if (cookies?.length) {
    // Keep only the fields Puppeteer's setCookie accepts (page.cookies() adds extras).
    const clean = cookies.map((c) => {
      const o = c as Record<string, unknown>;
      const p: Record<string, unknown> = { name: o.name, value: o.value };
      for (const k of ["domain", "path", "expires", "httpOnly", "secure", "sameSite", "url"])
        if (o[k] !== undefined) p[k] = o[k];
      return p;
    });
    try {
      await page.setCookie(...(clean as unknown as Parameters<Page["setCookie"]>));
    } catch {
      /* some cookies may be rejected (e.g. bad domain) — best effort */
    }
  }
}

// Captured localStorage is per-origin and only applies once the page is on that origin,
// so it runs AFTER the first navigation. Returns true if anything was injected (→ reload).
async function applyPostNav(page: Page, storageState?: StorageState | null): Promise<boolean> {
  const origins = storageState?.origins;
  if (!origins?.length) return false;
  let injected = false;
  try {
    const here = new URL(page.url()).origin;
    const match = origins.find((o) => o.origin === here) ?? origins[0];
    if (match?.localStorage?.length) {
      await page.evaluate((items: { name: string; value: string }[]) => {
        for (const it of items) {
          try {
            window.localStorage.setItem(it.name, it.value);
          } catch {
            /* quota / disabled — skip */
          }
        }
      }, match.localStorage);
      injected = true;
    }
  } catch {
    /* cross-origin / no storage — skip */
  }
  return injected;
}

export interface Session {
  agent: PuppeteerAgent;
  page: Page;
  browser: Browser;
  walletId?: string;
  walletUnlocked?: boolean;
  walletPage?: Page; // kept-open MetaMask page holding the unlock (MV3 keep-alive)
  injectedAddress?: string; // address of the injected virtual wallet (injected mode)
  sentTxs?: string[]; // tx hashes the injected wallet sent this session (live-updated)
  cleanup: () => Promise<void>;
  /** Private local adapter connection, retained only for this browser's lifetime. */
  executorModel?: RoleModelConnection;
  modelRequests?: RoleRequestRecord[];
}

export interface LaunchOpts {
  signal?: AbortSignal;
  modelBudget?: RoleProxyBudget;
  executorModel?: RoleModelConnection;
  wallet?: boolean; // load the MetaMask extension
  unlock?: boolean; // unlock the onboarded wallet (default true when onboarded)
  injected?: boolean; // inject a virtual wallet (no extension) pointed at a configurable RPC
  rpcUrl?: string; // override the injected wallet's chain RPC
  chainId?: number; // override the injected wallet's chainId
  cacheContext?: unknown;
  cacheId?: string; // Midscene cache key (with MIDSCENE_CACHE=1, re-runs replay from cache)
  headless?: boolean;
  extraHeaders?: Record<string, string>; // fixed request headers (resolved, secrets injected)
  query?: Record<string, string>; // fixed query-string params appended to navigations
  storageState?: StorageState | null; // captured login state → cookies + localStorage injected
  /**
   * 一个**持续登录**的 profile 目录。给了它就用它启动，且**不再注入 `storageState`**——
   * profile 自己带着登录态。这是给那些「光 replay cookie 过不去」的站点用的
   * （Binance 的私有接口要它自家 JS 生成的头、会话绑浏览器指纹；见 `testpilot-binance-sut`）：
   * 在这个 profile 里手动登录一次，之后每次执行都复用它，指纹和头都还在。
   * 与 `wallet`/`injected` 互斥（那两条各有自己的 profile 规矩）。
   */
  sutProfileDir?: string;
  /**
   * 变异体：往这一个浏览器会话里注入一个人造缺陷，看用例会不会叫。
   *
   * **被测应用一个字节都不改**——变的只是这个会话看到的那份 DOM。这一点是黑盒变异测试
   * 成立的关键：两次运行之间被测对象仍然是同一个东西。见 `mutate/inject.ts`。
   */
  mutation?: { id: string; script: string };
  /**
   * 这个被测对象要多大的视口。
   *
   * 环境上的一个字段，不是全局环境变量：把默认调大会让所有 SUT 的每一次
   * 模型调用都跟着变贵，而大多数界面在 1024 下是完整的。不给就用默认。
   */
  viewport?: Partial<Viewport>;
}

// Launch Chrome for Testing (Puppeteer's default build) and wrap the page in a Midscene agent.
// Extensions require the NEW headless mode (headless:true in Puppeteer v23) + full Chrome —
// NOT chrome-headless-shell. We also use a persistent userDataDir, required for extensions.
/**
 * 在一个已经开着的页面上换一个 agent：复用会话时每条用例要有自己的 `cacheId`（缓存按用例存），
 * 但浏览器与页面是同一个——登录态就在这个页面里。
 */
export function newAgent(page: Page, cacheId?: string, executorModel?: RoleModelConnection): PuppeteerAgent {
  const agent = new PuppeteerAgent(page, { ...(cacheId ? { cacheId } : {}),
    modelConfig: midsceneModelConfig(executorModel ?? executorConnectionFromEnv()) });
  const readContext=agent.getUIContext.bind(agent);
  agent.getUIContext=async action=>{
    const context=await readContext(action);
    // Assertions and waits also use the visible scene. Full DOM evidence is collected separately.
    return {...context,tree:visibleContextTree(context.tree)};
  };
  return agent;
}

async function contextualAgent(page:Page,opts:LaunchOpts,connection?:RoleModelConnection) {
 /**
  * 结构指纹而不是 DOM+截图：见 cache.ts 的注释。实时行情页上后者几乎必然每次不同。
  *
  * **采不到就不缓存，而不是带垮这次执行。** 这一步可能赶上页面正在导航——那时执行上下文
  * 已经销毁，`page.evaluate` 会抛。2026-09-15 实测：本机四条 runner 测试全绿，CI 上三条红，
  * 其中一条正是「导航还没完成就取消」——CI 慢，正好撞进那个窗口。
  *
  * 抛了就返回 `undefined`：这一次不读也不写缓存。诚实的做法是「这一屏是什么我没看清，
  * 那就别拿别的屏的计划来用」——退回一个凑合的键，换来的是照着过时计划去点不存在的元素，
  * 而那种失败看起来像产品坏了。
  */
 const structure = opts.cacheId ? await page.evaluate(STRUCTURE_PROBE)
   .then((controls) => structureOf(controls as Array<{tag:string;role?:string|null;label?:string|null}>))
   .catch(() => undefined) : undefined;
 const cacheId = structure === undefined ? undefined
   : scopedCacheId(opts.cacheId, opts.cacheContext, { url: page.url(), structure });
 return newAgent(page,cacheId,connection??opts.executorModel);
}

/**
 * 复用会话：同一个页面上 `goto` 回起点，换这条用例自己的 agent（cacheId 按用例）。
 *
 * **不能换新标签页**（07 T-28 试过）：Hyperliquid 把 Enable Trading 的 agent 密钥放在 sessionStorage，
 * 那是按标签页的——新页面一开就回到「Enable Trading」，登录态白做。同页 goto 保得住。
 * 等到网络安静再交给用例：新浏览器有起浏览器 + 登录态几十秒的缓冲，复用没有；WebSocket 不算在飞的请求，能收口。
 */
export async function reopenPage(session: Session, url: string, opts: LaunchOpts): Promise<Session> {
  opts = {...opts, cacheContext:{model:cacheDigest(opts.executorModel??executorConnectionFromEnv()),context:opts.cacheContext??null}};
  const navUrl = appendQuery(url, opts.query);
  session.sentTxs?.splice(0);
  await session.page.goto(navUrl, { waitUntil: "networkidle2", timeout: 45000 }).catch(() => session.page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 }));
  return { ...session, agent: await contextualAgent(session.page, opts, session.executorModel ?? opts.executorModel) };
}

export async function launchSession(
  url: string,
  opts: LaunchOpts = {},
): Promise<Session> {
  const originalModel = opts.executorModel ?? executorConnectionFromEnv();
  opts = {...opts, cacheContext:{model:cacheDigest(originalModel),context:opts.cacheContext??null}};
  const proxy = await openRoleProxy(originalModel, undefined, opts.modelBudget);
  let browser: Browser | undefined;
  const cancel = () => { void browser?.close().catch(() => {}); void proxy.close(); };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (opts.signal?.aborted) throw new Error("EXEC_CANCELLED");
    const session = await launchBrowserSession(url, { ...opts, executorModel: proxy.connection }, launched => { browser = launched; if (opts.signal?.aborted) { cancel(); throw new Error("EXEC_CANCELLED"); } });
    return { ...session, executorModel: proxy.connection, modelRequests: proxy.records, cleanup: async () => {
      try { await session.cleanup(); } finally { opts.signal?.removeEventListener("abort", cancel); await proxy.close(); }
    } };
  } catch (error) {
    try { await browser?.close(); } finally { opts.signal?.removeEventListener("abort", cancel); await proxy.close(); }
    throw error;
  }
}

async function launchBrowserSession(url: string, opts: LaunchOpts, onLaunch: (browser: Browser) => void): Promise<Session> {
  // Injected virtual wallet mode: no extension, headless, provider proxies to a config RPC.
  if (opts.injected) {
    const cfg = resolveChainConfig({ rpcUrl: opts.rpcUrl, chainId: opts.chainId });
    const browser = await puppeteer.launch({
      headless: opts.headless ?? true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    onLaunch(browser);
    const page = await browser.newPage();
    await page.setViewport(resolveViewport(opts.viewport));
    await installQueryInterception(page, opts.query);
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    const { address, sentTxs } = await setupInjectedWallet(page, cfg);
    await installMutation(page, opts);
    await applyPreNav(page, opts);
    const navUrl = appendQuery(url, opts.query);
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (await applyPostNav(page, opts.storageState))
      await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const agent = await contextualAgent(page, opts);
    const cleanup = async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    };
    return { agent, page, browser, injectedAddress: address, sentTxs, cleanup };
  }

  const wantsWallet = opts.wallet && isWalletInstalled();

  const args = ["--no-sandbox", "--disable-setuid-sandbox"];
  if (wantsWallet) {
    args.push(
      `--disable-extensions-except=${WALLET_DIR}`,
      `--load-extension=${WALLET_DIR}`,
    );
  }

  // Use the onboarded profile (test wallet already imported) when available; else a
  // fresh temp profile. Extensions require a real profile dir either way.
  const onboarded = wantsWallet && isWalletOnboarded();
  // MetaMask's onboarding-completion + connect popups need a real display; headless
  // leaves the wallet half-initialized. Default wallet runs to HEADED (override with
  // opts.headless, or HEADLESS=1 env). Non-wallet runs stay headless.
  const headless =
    opts.headless ??
    (wantsWallet ? process.env.HEADLESS === "1" : true);
  // A persistent, already-logged-in profile for the SUT (non-wallet runs only). When set we
  // launch on it and skip storageState injection — the profile carries the session. This is
  // the path for sites whose auth cannot be reproduced by replaying cookies into a blank
  // context. Automation flags are stripped so the window is an ordinary Chrome (some sites
  // gate login behind an is-automated check).
  const sutProfile = !wantsWallet && !opts.injected ? opts.sutProfileDir : undefined;
  // 持续 profile 必须用**登录它的那个 app**来驱动:macOS 的 cookie 密钥挂在 Keychain 的
  // "Chrome Safe Storage",按 app 身份取。用 Chrome for Testing 打开一个由正式版 Chrome 登录的
  // profile,解不开加密 cookie,登录态就丢了。所以 sutProfile 在场时默认指向正式版 Chrome。
  const REAL_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = sutProfile
    ? process.env.PUPPETEER_EXECUTABLE_PATH || REAL_CHROME
    : process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless, // wallet → headed; otherwise new headless
    executablePath,
    args,
    userDataDir: sutProfile
      ? sutProfile
      : onboarded
        ? PROFILE_DIR
        : wantsWallet
          ? mkdtempSync(join(tmpdir(), "testpilot-profile-"))
          : undefined,
    // Puppeteer disables extensions by default; allow them. Strip the automation banner for
    // a persistent SUT profile so the page sees a normal browser.
    ignoreDefaultArgs: wantsWallet
      ? ["--disable-extensions"]
      : sutProfile
        ? ["--enable-automation"]
        : undefined,
  });
  onLaunch(browser);

  let walletId: string | undefined;
  let walletUnlocked: boolean | undefined;
  let walletPage: Page | undefined;
  if (wantsWallet) {
    try {
      walletId = await getExtensionId(browser);
      // Auto-unlock the onboarded wallet so dapp tests start with a ready wallet.
      // Keep the returned page open — it holds the MV3 service worker alive.
      if (walletId && onboarded && opts.unlock !== false) {
        const r = await unlockWallet(browser, walletId);
        walletUnlocked = r.unlocked;
        walletPage = r.page;
      }
    } catch {
      // extension failed to register a worker — continue without it
    }
  }

  const page = await browser.newPage();
  // Downsampled viewport (see resolveViewport): keeps the vision-model prompt small enough
  // for memory-constrained self-hosted models (MLX prefill guard). Same as the injected path.
  await page.setViewport(resolveViewport(opts.viewport));
  await installQueryInterception(page, opts.query);
  // **两条启动路径都要装。**第一版只写在注入钱包那条分支里，而正常执行走的是这一条
    // ——于是变异体一次都没装上，计数恒为 0，我先后怀疑了时机和 API，都不是。
    await installMutation(page, opts);
    await applyPreNav(page, opts);
  const navUrl = appendQuery(url, opts.query);
  // domcontentloaded (not networkidle0): robust for sites with analytics/polling that
  // never fully idle. aiAction waits for its target elements anyway.
  await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Inject captured localStorage (per-origin) then reload so the app reads it.
  if (await applyPostNav(page, opts.storageState))
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

  const agent = await contextualAgent(page, opts);
  const cleanup = async () => {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  };
  return { agent, page, browser, walletId, walletUnlocked, walletPage, cleanup };
}

// Open the wallet's own UI page (onboarding/home) so an agent can drive it.
export async function openWalletPage(
  browser: Browser,
  walletId: string,
  path = "home.html",
): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${walletId}/${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  return page;
}

export async function screenshotBase64(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 60 });
  return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
}
