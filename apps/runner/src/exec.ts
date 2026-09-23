import type {SessionCheck,InjectedSessionCheck} from "@testpilot/harness-testing/domain";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureSession,
  checkWallet,
  executeRun,
  releaseRunSession,
  walletDappTest,
  runDebug,
  runExplore,
  runObserve,
  type ObserveSpec,
  type ObserveResult,
  verifyDapp,
  type DebugSpec,
  type ExploreResult,
  type ExploreSpec,
  type CaptureSessionSpec,
  type CaptureSessionResult,
  type DappVerifySpec,
  type DappVerifyResult,
  type WalletDappTestSpec,
  type WalletDappTestResult,
  type RunResult,
  type Preparation,
  type WalletCheckResult,
} from "@testpilot/harness-testing";
import type { ChainAssertion, MachineOracle, StorageState } from "@testpilot/harness-testing";
import type { ResolveContext } from "@testpilot/harness-core";
import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";

/**
 * One execution = one browser session, then the process is free again. The runner is
 * stateless on purpose: everything it learns leaves in the result or on the event bus.
 */
export interface ExecSpec {
  /** Server resolves this project's executor before dispatch. */
  scopeProjectId?: string;
  modelSnapshotRunId?: string;
  execId: string;
  url: string;
  steps: string[];
  expected: string;
  /** Where step screenshots are written. Refs travel back, bytes do not. */
  artifactDir: string;
  opts: {
    captureObservations?: boolean;
    preparation?: Preparation;
    executorModel?: RoleModelConnection;
    modelBudget?: { maxCalls?: number; deadlineAt?: number };
    injected?: boolean;
    wallet?: boolean;
    rpcUrl?: string;
    chainId?: number;
    cacheId?: string;
    /** 批次级浏览器复用的 key（07 T-28）。 */
    sessionKey?: string;
    authentication?: {sessionChecks?:SessionCheck[];injectedSessionCheck?:InjectedSessionCheck};
    login?: string[];
    postSteps?: string[];
    resolve?: ResolveContext;
    rowLabel?: string;
    extraHeaders?: Record<string, string>;
    query?: Record<string, string>;
    /** 探索记下的控件文案与选择器；执行时先试它，验不过就交回模型。见 run.ts 的 byLocator。 */
    locators?: Array<{ label: string; selector: string; featureId?: string }>;
    storageState?: StorageState | null;
    /** A check a program settles. When present the model is never asked for the verdict. */
    oracle?: MachineOracle;
    /** v2 把判据挂在每条断言上；不带过来的话 tier 1 在执行时只是一个标签。见 run.ts。 */
    assertions?: Array<{ id?: string; statement: string; oracle?: MachineOracle; afterStep?: number }>;
    /** 这个被测对象要多大的视口。不给用执行器默认的 1024×720。 */
    viewport?: { width?: number; height?: number };
    /**
     * 这一次要注进浏览器的变异体。
     *
     * 注在**浏览器会话里**，不注在被测应用里——被测应用一个字节都不改，容器不重建，
     * 两次运行之间它仍然是同一个东西。变的只是这一个会话看到的那一份 DOM。
     * 执行器跑完会把「改了几处」放进 `mutationApplied`：0 处不是「活下来」，是**没生效**。
     */
    mutation?: { id: string; script: string };
    web3?: {
      chainAssertions: ChainAssertion[];
      rpcUrl: string;
      account: string;
      settleMs?: number;
    };
  };
}

/**
 * Same shape as a local run, minus the pixels: PNGs are written to disk and referenced by
 * path. Passing megabytes of base64 across the IPC channel would make every screenshot a
 * copy in three places — and the gateway needs them as files anyway, to diff against the
 * stored baselines.
 */
export type ExecResult = Omit<RunResult, "pngBuffers" | "screenshots"> & {
  pngPaths: string[];
};

export async function execCase(spec: ExecSpec): Promise<ExecResult> {
  const controller = new AbortController();
  live.set(spec.execId, { cancel: () => controller.abort() });
  try {
  const dir = resolve(spec.artifactDir, "exec");
  mkdirSync(dir, { recursive: true });
  const { pngBuffers, screenshots: _dataUrls, ...rest } = await executeRun(
    spec.url,
    spec.steps,
    spec.expected,
    { ...spec.opts, signal: controller.signal },
  );
  void _dataUrls;
  const pngPaths = pngBuffers.map((buf, i) => {
    const path = resolve(dir, `${spec.execId}-${i}.png`);
    writeFileSync(path, buf);
    return path;
  });
  return { ...rest, pngPaths };
  } finally { live.delete(spec.execId); }
}

/** 批次结束时关掉复用的浏览器。 */
export const releaseSession = (key: string): Promise<boolean> => releaseRunSession(key);

/* ---- interactive sessions (explore / live debug) ---- */
// These stream frames instead of returning one result. The frames go out on the event bus
// and the gateway relays them to the browser, so the UI contract (SSE) is unchanged while
// the browser itself now lives over here.

export type { DebugSpec, ExploreSpec, ExploreResult };

export interface InteractiveHandle {
  cancel(): void;
}

const live = new Map<string, InteractiveHandle>();

export function cancelInteractive(execId: string): boolean {
  const h = live.get(execId);
  h?.cancel();
  return !!h;
}

/** Cancel everything this runner is currently doing. Returns how many sessions it stopped. */
export function cancelAll(): number {
  const n = live.size;
  for (const h of live.values()) h.cancel();
  live.clear();
  return n;
}

export async function exploreSession(
  spec: ExploreSpec,
  emit: (evt: Record<string, unknown>) => void,
): Promise<ExploreResult> {
  const token = { cancelled: false };
  live.set(spec.execId, { cancel: () => (token.cancelled = true) });
  try {
    return await runExplore(spec, emit, token);
  } finally {
    live.delete(spec.execId);
  }
}

export async function observeSession(
  spec: ObserveSpec,
  emit: (evt: Record<string, unknown>) => void,
): Promise<ObserveResult> {
  const token = { cancelled: false };
  live.set(spec.execId, { cancel: () => (token.cancelled = true) });
  try {
    return await runObserve(spec, emit, token);
  } finally {
    live.delete(spec.execId);
  }
}

export async function debugSession(
  spec: DebugSpec,
  emit: (evt: Record<string, unknown>) => void,
): Promise<void> {
  const token = { cancelled: false };
  live.set(spec.execId, { cancel: () => (token.cancelled = true) });
  try {
    await runDebug(spec, emit, token);
  } finally {
    live.delete(spec.execId);
  }
}

/* ---- web3 diagnostics ---- */
// One-shot checks that still open a browser, so they live where every other browser lives.

export type {
  ObserveSpec,
  ObserveResult,
  CaptureSessionSpec,
  CaptureSessionResult,
  DappVerifySpec,
  DappVerifyResult,
  WalletCheckResult,
  WalletDappTestSpec,
  WalletDappTestResult,
};

export const diagnostics = {
  verifyDapp: (spec: DappVerifySpec): Promise<DappVerifyResult> => verifyDapp(spec),
  checkWallet: (path?: string): Promise<WalletCheckResult> => checkWallet(path),
  walletDappTest: (spec: WalletDappTestSpec): Promise<WalletDappTestResult> => walletDappTest(spec),
  captureSession: (spec: CaptureSessionSpec): Promise<CaptureSessionResult> => captureSession(spec),
};
