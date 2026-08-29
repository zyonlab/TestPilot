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
  const injected = !!opts.injected;
  const wallet = !injected && !!opts.wallet;
  const ctx: ResolveContext = opts.resolve ?? { env: {}, secrets: {} };
  const secretVals = Object.values(ctx.secrets);
  const rlog = (s: string) => logs.push(redact(s, secretVals));
  const startedAt = new Date().toISOString();
  const sinceMs = Date.now();
  const t0 = sinceMs;
  const logs: string[] = [];
  /** 变异体改了几处。`undefined` = 这次没注变异体；`0` = 注了但没生效。 */
  let mutationApplied: number | undefined;
  /** 判据求值时页面停在哪——用来分辨「判错」和「没走到」。 */
  let endedAt: string | undefined;
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
      mutation: opts.mutation,
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
      endedAt = snapAfter.url;
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
    const message = redact((e as Error).message, secretVals);
    logs.push(`error: ${message}`);
    return {
      status: "failed",
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
    stopApprover?.();
    await session?.cleanup();
  }
}

