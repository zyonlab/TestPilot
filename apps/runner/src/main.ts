import { EventKind, setModelLease, startChild } from "@testpilot/harness-core";
import {
  cancelAll,
  cancelInteractive,
  diagnostics,
  debugSession,
  execCase,
  exploreSession,
  observeSession,
  type DebugSpec,
  type ExecResult,
  type ExecSpec,
  type ExploreResult,
  type ExploreSpec,
  type ObserveResult,
  type ObserveSpec,
  type DappVerifySpec,
  type DappVerifyResult,
  type WalletCheckResult,
  releaseSession,
} from "./exec.js";

/**
 * The runner process: one execution at a time (Midscene session, screenshot + perf
 * capture, chain assertions), stateless, killable.
 *
 * Restart policy for this process is deliberately `never` — a runner that died has a
 * reason, and whether to retry the WORK belongs to the loop layer, not the supervisor.
 */
let busy = false;

const child = startChild({
  heartbeatMs: 1000,
  api: {
    capabilities: async () => ({ web: true, android: false, ios: false }),
    /** Run one case. Rejects while another run holds this process. */
    exec: async (spec: ExecSpec): Promise<ExecResult> => {
      if (busy) throw new Error("runner busy");
      busy = true;
      child.setTask(`exec ${spec.execId}`);
      child.emit(
        EventKind.runProgress,
        { phase: "start", url: spec.url, steps: spec.steps.length },
        { runId: spec.execId },
      );
      try {
        const result = await execCase(spec);
        // Cost is attributed per process: this is where the vision-model time is actually spent.
        if (result.modelRequests) child.addSpend({ calls: result.modelRequests.filter(r => r.forwarded).length });
        child.emit(
          EventKind.runProgress,
          {
            phase: "done",
            status: result.status,
            shots: result.pngPaths.length,
            perf: result.perfMetrics,
            infraError: result.infraError,
          },
          { runId: spec.execId },
        );
        return result;
      } finally {
        busy = false;
        child.setTask("idle");
      }
    },
    /**
     * Explore and live debug: long, streamed sessions. Every frame goes out as a
     * `session.progress` event scoped to the execId; the gateway relays those to the
     * browser. Not coalesced — dropping a step frame would lose the story of the run.
     */
    explore: async (spec: ExploreSpec): Promise<ExploreResult> => {
      child.setTask(`explore ${spec.execId}`);
      try {
        return await exploreSession(spec, (evt) =>
          child.emit(EventKind.sessionProgress, evt, { runId: spec.execId }),
        );
      } finally {
        child.setTask("idle");
      }
    },
    /** 观察：采集是确定性的，所以它不产 flows，也不问模型「这该怎么测」。 */
    observe: async (spec: ObserveSpec): Promise<ObserveResult> => {
      child.setTask(`observe ${spec.execId}`);
      try {
        return await observeSession(
          {
            ...spec,
            /**
             * 「探索之前先问一次业务场景」由这里组装。
             *
             * 函数过不了 RPC 边界，所以网关不能把 `ask` 直接塞进 spec——
             * 第一版就是这么写的，序列化时被丢掉，表现成"计划永远是 null"。
             * 这个进程里没有 ModelClient（只领模型票），端点也被改写成了 no-think 代理，
             * 所以真正问模型的是网关，这里只是把请求转过去。
             */
            ask: async (req) =>
              String(
                await child.parent.askModel({
                  projectId: spec.projectId,
                  prompt: req.prompt,
                  imageDataUrl: req.imageDataUrl,
                  schema: req.schema,
                  maxTokens: req.maxTokens,
                } as never),
              ),
          },
          (evt) => child.emit(EventKind.sessionProgress, evt, { runId: spec.execId }),
        );
      } finally {
        child.setTask("idle");
      }
    },
    debug: async (spec: DebugSpec): Promise<void> => {
      child.setTask(`debug ${spec.execId}`);
      try {
        await debugSession(spec, (evt) =>
          child.emit(EventKind.sessionProgress, evt, { runId: spec.execId }),
        );
      } finally {
        child.setTask("idle");
      }
    },
    /** Web3 diagnostics from the config pages. Same process, same lifecycle, same cleanup. */
    verifyDapp: async (spec: DappVerifySpec): Promise<DappVerifyResult> => {
      child.setTask("verify dapp");
      try {
        return await diagnostics.verifyDapp(spec);
      } finally {
        child.setTask("idle");
      }
    },
    walletDappTest: async (spec: unknown) => {
      child.setTask("wallet dapp test");
      try {
        return await diagnostics.walletDappTest(spec as Parameters<typeof diagnostics.walletDappTest>[0]);
      } finally {
        child.setTask("idle");
      }
    },
    captureSession: async (spec: unknown) => {
      child.setTask("capture session");
      try {
        return await diagnostics.captureSession(spec as Parameters<typeof diagnostics.captureSession>[0]);
      } finally {
        child.setTask("idle");
      }
    },
    checkWallet: async (path?: string): Promise<WalletCheckResult> => {
      child.setTask("check wallet");
      try {
        return await diagnostics.checkWallet(path);
      } finally {
        child.setTask("idle");
      }
    },
    /** The UI closed the stream: stop the work rather than leave a browser open. */
    cancel: async (execId: string): Promise<boolean> => cancelInteractive(execId),
    /** 批次结束：关掉这个 key 下复用的浏览器（07 T-28）。 */
    releaseSession: async (key: string): Promise<boolean> => releaseSession(key),
    /**
     * "Stop what you are doing" from the process page. Interactive sessions cancel
     * cooperatively; a case run in progress is not interruptible yet, so the caller is
     * told what was actually stopped rather than being left to assume.
     */
    cancelAll: async (): Promise<{ stopped: number; busy: boolean }> => ({
      stopped: cancelAll(),
      busy,
    }),
  },
  onShutdown: () => {
    child.emit(EventKind.log, { stream: "runner", text: "runner draining" });
  },
});

// Model admission is global, not per-process: the gateway owns the gate and hands out
// slots. Without this, an explore and a case run in this same process would hit the
// self-hosted model at the same time — which is exactly how it starts returning 502s.
setModelLease(async (fn) => {
  const ticket = (await child.parent.acquireModel()) as unknown as number;
  try {
    return await fn();
  } finally {
    void child.parent.releaseModel(ticket as never);
  }
});

child.setTask("idle");
child.emit(EventKind.log, { stream: "runner", text: `runner ${child.id} up` });
