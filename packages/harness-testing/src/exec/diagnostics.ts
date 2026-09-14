import { launchSession, openWalletPage, screenshotBase64 } from "./session.js";
import { isWalletInstalled, isWalletOnboarded, startPopupApprover, TEST_ACCOUNT } from "./wallet.js";
import { resolveText, redact, type ResolveContext } from "@testpilot/harness-core";
import { withModel } from "@testpilot/harness-core";
import type { ChainConfig, StorageState } from "../types.js";

/**
 * Web3 diagnostics: "is the injected wallet actually working against this chain", and
 * "did the extension really load".
 *
 * They are one-shot checks rather than test cases, but they open a browser, and everything
 * that opens a browser belongs in the runner: one process owns that resource, one place
 * crashes when a page hangs, one place to look when something leaks.
 */

export interface DappVerifySpec {
  url: string;
  chain: ChainConfig;
}

export interface DappVerifyResult {
  account?: string;
  chain: ChainConfig;
  connect: string;
  tx: string;
  mined: boolean;
  txStatus?: string;
  block?: string;
  screenshot: string;
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<{ status?: string; blockNumber?: string } | null> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await r.json()) as { result?: { status?: string; blockNumber?: string } }).result ?? null;
}

export async function verifyDapp(spec: DappVerifySpec): Promise<DappVerifyResult> {
  let session;
  try {
    session = await launchSession(spec.url, {
      injected: true,
      rpcUrl: spec.chain.rpcUrl,
      chainId: spec.chain.chainId,
    });
    const page = session.page;
    const status = () => page.$eval("#status", (el) => el.textContent || "").catch(() => "");
    // Poll the page's own status element rather than sleeping a fixed time: the chain's
    // latency is not knowable in advance, and a fixed wait is wrong on both sides.
    const waitStatus = async (pred: (s: string) => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = await status();
        if (pred(s)) return s;
        await new Promise((r) => setTimeout(r, 400));
      }
      return status();
    };

    await page.evaluate(() => (document.getElementById("connect") as HTMLElement | null)?.click());
    const connect = await waitStatus((s) => s.startsWith("connected:") || s.startsWith("connect-error:"), 30000);

    await page.evaluate(() => (document.getElementById("sendtx") as HTMLElement | null)?.click());
    const tx = await waitStatus((s) => s.startsWith("tx:") || s.startsWith("tx-error:"), 30000);

    let receipt: { status?: string; blockNumber?: string } | null = null;
    if (tx.startsWith("tx:")) {
      const hash = tx.slice(3).trim();
      for (let i = 0; i < 20; i += 1) {
        receipt = await rpc(spec.chain.rpcUrl, "eth_getTransactionReceipt", [hash]);
        if (receipt) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    return {
      account: session.injectedAddress,
      chain: spec.chain,
      connect,
      tx,
      mined: !!receipt,
      txStatus: receipt?.status,
      block: receipt?.blockNumber,
      screenshot: await screenshotBase64(page),
    };
  } finally {
    await session?.cleanup();
  }
}

export interface WalletCheckResult {
  installed: boolean;
  onboarded: boolean;
  extensionId?: string;
  unlocked?: boolean;
  screenshot?: string;
  error?: string;
}

export async function checkWallet(path = "home.html"): Promise<WalletCheckResult> {
  if (!isWalletInstalled())
    return { installed: false, onboarded: false, error: "Wallet not installed. Run: pnpm setup:wallet" };

  let session;
  try {
    session = await launchSession("about:blank", { wallet: true });
    if (!session.walletId)
      return { installed: true, onboarded: isWalletOnboarded(), error: "the extension registered no worker" };
    const page =
      session.walletPage ?? (await openWalletPage(session.browser, session.walletId, path));
    return {
      installed: true,
      onboarded: isWalletOnboarded(),
      extensionId: session.walletId,
      unlocked: session.walletUnlocked,
      screenshot: await screenshotBase64(page),
    };
  } finally {
    await session?.cleanup();
  }
}


/* ---- MetaMask smoke test (headed: the extension's popups need a real display) ---- */

export interface WalletDappTestSpec {
  url: string;
}
export interface WalletDappTestResult {
  connect: string;
  sign: string;
  account: string;
  screenshot: string;
}

export async function walletDappTest(spec: WalletDappTestSpec): Promise<WalletDappTestResult> {
  if (!isWalletOnboarded()) throw new Error("Wallet not onboarded. Run: pnpm setup:onboard");
  let session;
  try {
    session = await launchSession(spec.url, { wallet: true });
    // The approver clicks through MetaMask's connect/sign popups while this drives the dapp.
    const stop = startPopupApprover(session.browser);
    const dapp = session.page;
    const status = () => dapp.$eval("#status", (el) => el.textContent || "").catch(() => "");
    const waitStatus = async (pred: (s: string) => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = await status();
        if (pred(s)) return s;
        await new Promise((r) => setTimeout(r, 400));
      }
      return status();
    };

    await dapp.evaluate(() => (document.getElementById("connect") as HTMLElement | null)?.click());
    const connect = await waitStatus((s) => s.startsWith("connected:") || s.startsWith("connect-error:"), 35000);

    let sign = "skipped";
    if (connect.startsWith("connected:")) {
      await dapp.evaluate(() => (document.getElementById("sign") as HTMLElement | null)?.click());
      sign = await waitStatus((s) => s.startsWith("signed:") || s.startsWith("sign-error:"), 35000);
    }
    stop();
    return { connect, sign, account: TEST_ACCOUNT, screenshot: await screenshotBase64(dapp) };
  } finally {
    await session?.cleanup();
  }
}

/* ---- capture a login session by driving the UI once ---- */

export interface CaptureSessionSpec {
  url: string;
  steps: string[];
  resolve: ResolveContext;
  extraHeaders?: Record<string, string>;
  query?: Record<string, string>;
}
export interface CaptureSessionResult {
  storageState: StorageState;
  log: string[];
}

/**
 * Log in once through the UI and keep what the browser ended up holding.
 *
 * Every later run injects this instead of logging in again — the difference between a
 * suite that spends a vision-model minute per case on a login and one that does not. The
 * steps are logged as templates, never with the values substituted in.
 */
export async function captureSession(spec: CaptureSessionSpec): Promise<CaptureSessionResult> {
  const secretVals = Object.values(spec.resolve.secrets ?? {});
  const log: string[] = [];
  let session;
  try {
    session = await launchSession(spec.url, {
      extraHeaders: spec.extraHeaders,
      query: spec.query,
    });
    for (const t of spec.steps) {
      log.push(redact(`login: ${t}`, secretVals));
      await withModel(() => session!.agent.aiAction(resolveText(t, spec.resolve)));
    }
    const cookies = await session.page.cookies();
    const ls = await session.page.evaluate(() => {
      const items: { name: string; value: string }[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k != null) items.push({ name: k, value: window.localStorage.getItem(k) ?? "" });
      }
      return { origin: location.origin, items };
    });
    return {
      storageState: {
        cookies: cookies as unknown as StorageState["cookies"],
        origins: ls.items.length ? [{ origin: ls.origin, localStorage: ls.items }] : [],
      },
      log,
    };
  } finally {
    await session?.cleanup();
  }
}
