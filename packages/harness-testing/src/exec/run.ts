// The executor: drive Midscene steps against a target, capture what a run leaves behind
// (screenshots, perf metrics, oracle results) and hand it back. It knows nothing about the
// database, baselines or artifacts — those live in the gateway, which is why this can run
// in the runner process.
import { launchSession } from "./session.js";
import { startPopupApprover } from "./wallet.js";
import { snapshotBalances, evalChainAssertion, collectReceipts, evalTxSubmitted } from "./chain.js";
import { capturePerf, type PerfMetrics } from "../baselines/perf.js";
import { resolveText, redact, withModel, type ResolveContext } from "@testpilot/harness-core";
import type { ChainAssertion, OracleCheck, StorageState } from "../types.js";
import { describeOracle, evaluateOracle, type MachineOracle, type PageSnapshot } from "./oracle.js";
import { classifyFailure, isInfraError, type Failure } from "../failure.js";

export interface RunResult {
  status: "passed" | "failed";
  durationMs: number;
  startedAt: string;
  logs: string[];
  screenshots: string[];
  pngBuffers: Buffer[]; // lossless PNG per screenshot, aligned with `screenshots`, for visual diff
  sinceMs: number; // when the run started (to locate its Midscene report)
  perfMetrics: PerfMetrics; // navigation/paint timing of the page under test
  oracle: OracleCheck[]; // functional assertion results (from the case's `expected`)
  failureReason?: string;
  infraError?: boolean; // model/network failure (not a real test failure) — excluded from flake/gate
  /** Structured classification of the failure: code + attribution (docs/spec/06). */
  failure?: Failure;
}

/**
 * What the page shows, as text and address.
 *
 * `innerText` rather than the DOM tree on purpose: a text case is end-agnostic, so the only
 * thing it can honestly refer to is what a person would read on the screen. No selectors
 * get invented here, and none leak into stage-one artifacts.
 */
async function snapshotPage(page: { evaluate: (fn: () => unknown) => Promise<unknown>; url: () => string }): Promise<PageSnapshot> {
  const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string;
  return { text: String(text ?? ""), url: page.url() };
}

export async function executeRun(
  url: string,
  steps: string[],
  expected: string,
  opts: {
    injected?: boolean;
    wallet?: boolean;
    rpcUrl?: string;
    chainId?: number;
    cacheId?: string;
    login?: string[]; // login-flow step templates (登录态), run before case steps
    postSteps?: string[]; // teardown/cleanup step templates, run after the assert
    resolve?: ResolveContext; // ${env.*}/${secret.*} resolution context
    rowLabel?: string; // data-driven row label, logged for forensics
    extraHeaders?: Record<string, string>; // fixed request headers (resolved)
    query?: Record<string, string>; // fixed query-string params
    storageState?: StorageState | null; // captured login state to inject
    /**
     * A check a program can settle. When present it decides the case and the model is
     * never asked — which is what makes a tier-1 label mean something at execution time.
     */
    oracle?: MachineOracle;
    web3?: {
      // dapp run: settle-wait after nav + on-chain assertions checked before/after the steps
      chainAssertions: ChainAssertion[];
      rpcUrl: string;
      account: string;
      settleMs?: number;
    };
  } = {},
): Promise<RunResult> {
  const injected = !!opts.injected;
  const wallet = !injected && !!opts.wallet;
  const ctx: ResolveContext = opts.resolve ?? { env: {}, secrets: {} };
  const secretVals = Object.values(ctx.secrets);
  const rlog = (s: string) => logs.push(redact(s, secretVals));
  const startedAt = new Date().toISOString();
  const sinceMs = Date.now();
  const t0 = sinceMs;
  const logs: string[] = [];
  const screenshots: string[] = [];
  const pngBuffers: Buffer[] = [];
  let session;
  let stopApprover: (() => void) | undefined;
  const shot = async () => {
    const png = Buffer.from(await session!.page.screenshot({ type: "png" }));
    pngBuffers.push(png);
    screenshots.push(`data:image/png;base64,${png.toString("base64")}`);
  };
  try {
    if (opts.rowLabel) rlog(`data row ${opts.rowLabel}`);
    logs.push(`navigate → ${url}${injected ? " (injected wallet)" : wallet ? " (with MetaMask)" : ""}`);
    const dataOpts = {
      extraHeaders: opts.extraHeaders,
      query: opts.query,
      storageState: opts.storageState,
    };
    session = await launchSession(
      url,
      injected
        ? { injected: true, rpcUrl: opts.rpcUrl, chainId: opts.chainId, cacheId: opts.cacheId, ...dataOpts }
        : { wallet, cacheId: opts.cacheId, ...dataOpts },
    );
    if (injected) logs.push(`injected wallet ${session.injectedAddress}`);
    else if (wallet && session.walletId) {
      stopApprover = startPopupApprover(session.browser);
      logs.push(`wallet ready (unlocked=${session.walletUnlocked})`);
    }
    await shot();
    // Login flow (登录态): resolve ${secret.*}/${env.*} for execution, but log the
    // TEMPLATE text so credentials never appear in logs/reports.
    const login = opts.login ?? [];
    if (login.length) {
      rlog(`login flow (${login.length} steps)`);
      for (const t of login) {
        rlog(`  login: ${t}`);
        await withModel(() => session!.agent.aiAction(resolveText(t, ctx)));
      }
      await shot();
    }
    // Dapp/SPA settle: give the app time to detect the injected wallet + render before we
    // act/assert (a bare domcontentloaded fires before a React dapp is interactive).
    if (opts.web3) {
      await new Promise((r) => setTimeout(r, opts.web3!.settleMs ?? 4000));
    }
    // A relation needs two observations: take the first one before anything happens.
    let snapBefore: PageSnapshot | undefined;
    if (opts.oracle?.kind === "delta") snapBefore = await snapshotPage(session.page);
    // On-chain snapshot BEFORE the steps, so balance-delta assertions measure their effect.
    let chainBefore: bigint[] = [];
    if (opts.web3?.chainAssertions?.length) {
      chainBefore = await snapshotBalances(opts.web3.rpcUrl, opts.web3.chainAssertions, opts.web3.account);
      rlog(`chain snapshot (before) — ${chainBefore.length} balance(s)`);
    }
    for (const [i, step] of steps.entries()) {
      rlog(`step ${i + 1}: ${step}`);
      await withModel(() => session!.agent.aiAction(resolveText(step, ctx)));
      await shot();
    }
    // Functional oracle: verify the case's expected outcome and record it structurally.
    const oracle: OracleCheck[] = [];
    let assertFailed: string | undefined;
    let infraError = false;
    // A machine-checkable oracle decides on its own and costs no model call. The judge is
    // the fallback, not the default: a case that says a program can settle it should be
    // settled by one, or the tier it carries is decoration.
    if (opts.oracle) {
      const shown = describeOracle(opts.oracle);
      rlog(`assert (machine): ${shown}`);
      const snapAfter = await snapshotPage(session.page);
      const verdict = evaluateOracle(opts.oracle, snapAfter, snapBefore);
      oracle.push({
        assertion: expected || shown,
        status: verdict.status,
        detail: verdict.detail,
        decidedBy: "machine",
      });
      if (verdict.status === "fail") assertFailed = verdict.detail;
      rlog(`assert ${verdict.status === "pass" ? "✓" : "✗"} — ${verdict.detail}`);
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
    // Teardown (post steps): best-effort cleanup so runs stay independent/repeatable.
    for (const t of opts.postSteps ?? []) {
      try {
        rlog(`teardown: ${t}`);
        await withModel(() => session!.agent.aiAction(resolveText(t, ctx)));
      } catch (e) {
        rlog(`teardown skipped — ${redact((e as Error).message, secretVals).slice(0, 70)}`);
      }
    }
    const perfMetrics = await capturePerf(session.page).catch(() => ({}) as PerfMetrics);
    return {
      status: assertFailed ? "failed" : "passed",
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
    const message = redact((e as Error).message, secretVals);
    logs.push(`error: ${message}`);
    return {
      status: "failed",
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
    stopApprover?.();
    await session?.cleanup();
  }
}

