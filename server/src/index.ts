import {explorationEnvironment} from './explorationReuse.js';
import { ExplorationAttemptSchema, sameExplorationAttempt, type ExplorationAttempt } from "@testpilot/harness-testing/domain";
import { LedgerError } from './runLedger.js';
import { recoverPreparations } from './preparation.js';
import { trackSourceSession } from "./sourceSessions.js";
import { benchmarkCatalog } from "./benchmarkCatalog.js";
import { listStudies, readStudy, startStudy, reviewStudy, evidenceFile, recoverStudies } from './evidenceStudy/runner.js';
import { readActiveEvolution } from './evolution/bridge.js';
import { environmentPatch } from "./environmentInput.js";
import { defaultRuntimeName, plannerRuntimeAvailable } from './runtimes.js';
import {storedScoreboard} from 'testpilot-mcp/score-store';
import {reviewCorsOptions} from './corsOptions.js';
import { intentPolicy, requestPrincipal } from "./intentPolicy.js";
import { recoverWorkflowExecutions } from "./workflowExecution.js";
import { flushDecisionDelivery, assertBoardApproval } from "./decisionDelivery.js";
import { reviewerPrincipal } from "./reviewPrincipal.js";
import express from "express";
import { runRouter } from "./runRoutes.js";
import { projectWorkflowEvent, recoverRunProjections } from "./runService.js";
import { degradeDecision, recordDegrade } from "./degrade.js";
import { projectCost } from "./cost.js";
import { createGoldDraft, readGoldState, saveGold, freezeGold, type GoldFile } from "./gold.js";
import { pairedEval } from "testpilot-mcp/score";
import cors from "cors";
import { INSTANCE } from "./datadir.js";
import { attachWs } from "./ws.js";
import {
  cancelRunnerWork,
  diagnoseOnRunner,
  execOnRunner,
  interactiveSession,
  readPngs,
  readShot,
  toDataUrls,
  releaseSessionOnRunners,
} from "./exec.js";
import { checkRun, classifyFailure, MachineOracleSchema } from "@testpilot/harness-testing";
import { ALL_ABLATABLE, validateGraph, describeDiff, trimMiddle } from "@testpilot/harness-core";
import {
  approve,
  batchAdjust,
  caseFromGap,
  editCase,
  pendingRuns,
  regenerate,
  reject,
  reviewBatch,
} from "./review.js";
import {
  DEFECT_TITLES,
  evalSubject, evaluateRegisteredRuns,
  getEval,
  listCritiques,
  listEvals,
  reconcileOrphanedEvals,
  runCritique, scoreRun,
  runDetectionEval,
  runPairedEval, startPairedEval, preflightPairedEval,
  setCaseExecutor,
} from "./evals.js";
import { getEvalSpec, listEvalSpecs, specFromSuggestion } from "./evalspecs.js";
import {
  activeRuns,
  allOutputs,
  cancelRun,
  missingUpstream,
  unfinishedRunIds,
  resumePoint,
  runDetail,
  getGraph,
  listGraphs,
  nodeOutput,
  executeCaseDirect,
  outputStore,
  reconcileOrphanedRuns,
  registry,
  saveGraph,
  getGraphVersion,
  graphVersions,
  diffGraphVersions,
  startRun,
  resumeRun,
  setRunBudget,
  model,
  setRunBreakpoints,
} from "./graphs.js";

import { runEnvReset, guardRun } from "./executionPolicy.js";

// Error responses carry the same code the run records store, so a caller can tell an
// environment problem from a real failure without parsing prose (docs/archive/spec/06 §2).
function failJson(res: express.Response, status: number, e: unknown) {
  const known = (e as { code?: string }).code;
  if (known?.startsWith("GUARD_"))
    return res.status(403).json({ error: (e as Error).message, code: known, retryable: false });
  const f = classifyFailure((e as Error).message ?? String(e));
  return res.status(status).json({ error: f.message, code: f.code, retryable: f.retryable });
}
import {
  addCapability,
  bus,
  setAgentObserver,
  setUnfinishedRuns,
  capabilities,
  setCapabilityCwd,
  config,
  modelGate,
  processStatuses,
  startProcesses,
  supervisor,
  takenProcessIds, eventStore, setChildAsk,
  midsceneDirFor } from "./procs.js";
import { applyGraphDraft, chat, checkPrompt, fieldSources, validRecipeOrThrow, type ChatContext, type ChatIntent } from "./chat.js";
import { changes, codeLine, codeProvenance } from "./codeline.js";
import { traceability, traceabilityOfRun } from "./trace.js";
import { allProjectOverviews, projectOverview } from "./overview.js";
import { runMutation } from "./mutationRun.js";
import { readMutationReport } from "./mutation.js";
import {
  checkBinding,
  deleteDataset,
  getDataset,
  inspectRows,
  listDatasets,
  parseRows,
  runSuffix,
  saveDataset,
  uniquify,
} from "./datasets.js";
import { pendingBaselines } from "./pending.js";
import { continuationsFor, continueRun } from "./continue.js";
import {
  PORT,
  resolveModelConfig,
  resolveChainConfig,
  setChainConfig,
  resolveModelRuntime,
} from "./config.js";
import { probeModel, generateCode, refineCase } from "./model.js";
import { describeModelConfig, saveModelConfig } from "./modelconfig.js";
import { listRulePacks, readRulePack, saveRulePack, deleteRulePack, currentRulePack } from "./rulePacks.js";
import { listDomainReferences, readDomainReference, saveDomainReference, deleteDomainReference } from "./domainReferences.js";
import { modelProfilesRouter } from "./modelProfilesRoutes.js";
import { projectPlannerModel } from "./modelProfiles.js";
// The executor moved to the domain package (it runs in the runner process now). The
// gateway still imports it directly for the paths that have not been migrated yet:
// explore, live debug and the wallet/dapp checks.
// No browser is opened in this process any more — every session lives on a runner. What
// is left here are the pure helpers (classification, guard, baselines) and wallet facts.
import {
  isWalletInstalled,
  isWalletOnboarded,
  TEST_ACCOUNT,
  snapshotBalances,
  evalChainAssertion,
  collectReceipts,
  evalTxSubmitted,
  captureMidsceneReport,
  diffPng,
  comparePerf,
  isInfraError,
  type PerfMetrics,
} from "@testpilot/harness-testing";
import type { Page } from "puppeteer";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listCases,
  getCase,
  createCase,
  updateCase,
  deleteCase,
  listRuns,
  listRunsByProject,
  getRun,
  createRun,
  getBaseline,
  upsertBaseline,
  getPerfBaseline,
  upsertPerfBaseline,
  updateRunResults,
  ARTIFACT_DIR,
  listEnvironments,
  getEnvironment,
  upsertEnvironment,
  type StorageState,
  type ChainAssertion,
  deleteEnvironment,
  resolveEnvironment,
  listSecretMeta,
  getSecretValues,
  setSecret,
  deleteSecret,
  computeFlakiness,
  getFlakiness,
  logQuarantine,
  recordBaselineVerdict,
  listQuarantineLog,
  listFlakiness,
  updateRunHealing,
  createBatch,
  updateBatch,
  getBatch,
  listBatches,
  addBatchRun,
  getBatchRuns,
  type Priority,
  type RunStatus,
  type VisualDiff,
  type OracleCheck,
  type Environment,
  type TestCase,
  type Batch,
  type RunRecord,
} from "./db.js";
import { enqueue, queueStatus } from "./queue.js";
import { computeTrends } from "./trends.js";
import {
  getSettings,
  updateSettings,
  resetPrompts,
  langDirective,
  DEFAULT_PROMPTS,
  LLM_DEBUG_DIR,
} from "./settings.js";
import { resolveText, resolveMap, redact, type ResolveContext } from "@testpilot/harness-core";
import {
  startRun as penguinStartRun,
  cancelRun as penguinCancelRun,
  workspaceOf as penguinWorkspaceOf,
  reconcilePenguinRuns,
} from "./penguinRun.js";
import { writeDecisions, type Decision, REPO_ROOT } from "./penguin.js";
import { NotFound, appendLabels, calibration, diff as auditDiff, scan as auditScan, holdsOf } from "./audit.js";

/**
 * 哪套 harness 在跑。
 *
 * `penguin`（默认）= v3 的那条路：起一个 Penguin session，产物落 `runs/<runId>/*.json`。
 * `graph` = 旧的图运行时，**Phase 3 才退役**——在那之前它是回滚开关，也是
 * `server/test/**` 里六个用真 `startRun` 的测试跑的那条路。两条并存的代价是一个 if；
 * 少了它，一次 Penguin 侧的故障就没有退路，而 `:5301` 上挂着已经完成的 Phase 2 前端。
 */
const RUNTIME = process.env.TP_RUNTIME === "graph" ? "graph" : "penguin";
import { seedIfEmpty } from "./seed.js";
import { buildExportFiles } from "./export.js";
import { exportLayerMemory, rememberExportLayers } from "./db.js";
import { supersededBoardCases, exportApprovedCases } from "./decisionDelivery.js";
import { processVisual } from "./visualBaseline.js";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  createReadStream,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const MIDSCENE_DIR = resolve(process.cwd(), "midscene_run");

const app = express();
app.use(cors(reviewCorsOptions));
app.use("/api/projects/:id/workflow-runs", express.json({ limit: "48mb" }));
app.use(express.json({ limit: "16mb" }));
app.use("/api", intentPolicy);
app.use("/api/projects/:projectId/workflow-runs", runRouter());
// 项目回归集：人批准过的回归候选（regressionCandidates.ts）。defect 是要一直跑的用例，rejection 是给生成器的反例评测项。
app.get("/api/projects/:id/regression-suite", async (req, res) => {
  const { regressionSuite } = await import("./regressionCandidates.js");
  res.json({ entries: regressionSuite(req.params.id, req.query.kind === "defect" || req.query.kind === "rejection" ? req.query.kind : undefined) });
});
app.use("/api/projects/:projectId/model-profiles", modelProfilesRouter());
// Serve baseline / current / diff images (referenced by VisualDiff.*Ref).
app.use("/api/artifacts", express.static(ARTIFACT_DIR));

const log = (...a: unknown[]) => console.log("[testpilot]", ...a);

// Prompt for AI test-planning is now a globally-configurable template (Model config →
// prompt templates). getSettings().prompts.explore holds the current text; the shipped
// default lives in settings.ts. Read it per-request so edits take effect immediately.

const CASE_TYPES = new Set(["functional", "negative", "boundary", "e2e"]);

// Minimal dapp for exercising wallet connect / signing locally (no testnet needed).
app.get("/testdapp", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>TestDapp</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>TestPilot dapp</h1>
  <button id="connect" style="padding:10px 16px;font-size:16px">Connect wallet</button>
  <button id="sign" style="padding:10px 16px;font-size:16px">Sign message</button>
  <button id="addchain" style="padding:10px 16px;font-size:16px">Use Anvil Local</button>
  <button id="sendtx" style="padding:10px 16px;font-size:16px">Send 0.01 ETH</button>
  <button id="wrap" style="padding:10px 16px;font-size:16px">Wrap 0.001 ETH → WETH (Sepolia)</button>
  <pre id="status" data-testid="status">idle</pre>
  <div id="banner"></div>
  <script>
    // Simulate a performance regression for perf-baseline demos: /testdapp?slow=1
    if (location.search.includes('slow')) { const _e = Date.now() + 900; while (Date.now() < _e) {} }
    const s = document.getElementById('status');
    const set = (t) => { s.textContent = t; };
    addEventListener('load', () => {
      set(window.ethereum ? 'provider:present' : 'provider:absent');
      // Simulate a UI change for visual-regression demos: /testdapp?changed=1
      if (location.search.includes('changed')) {
        const b = document.getElementById('banner');
        b.textContent = '🔴 SUMMER SALE — 50% OFF EVERYTHING';
        b.style.cssText = 'background:#e11d48;color:#fff;font-size:22px;font-weight:700;padding:18px;margin:12px 0;border-radius:8px;text-align:center';
      }
    });
    connect.onclick = async () => {
      try { const a = await ethereum.request({ method: 'eth_requestAccounts' }); set('connected:' + a[0]); }
      catch (e) { set('connect-error:' + e.message); }
    };
    sign.onclick = async () => {
      try {
        const a = await ethereum.request({ method: 'eth_accounts' });
        const sig = await ethereum.request({ method: 'personal_sign', params: ['TestPilot hello', a[0]] });
        set('signed:' + sig.slice(0, 20) + '…');
      } catch (e) { set('sign-error:' + e.message); }
    };
    addchain.onclick = async () => {
      try {
        await ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: '0x7a69', chainName: 'Anvil Local',
          rpcUrls: ['http://127.0.0.1:8545'],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }]});
        set('chain:' + await ethereum.request({ method: 'eth_chainId' }));
      } catch (e) { set('chain-error:' + (e.code||'') + ':' + e.message); }
    };
    sendtx.onclick = async () => {
      try {
        const a = await ethereum.request({ method: 'eth_accounts' });
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{
          from: a[0], to: '0x000000000000000000000000000000000000dEaD', value: '0x2386f26fc10000',
        }]});
        set('tx:' + hash);
      } catch (e) { set('tx-error:' + (e.code||'') + ':' + e.message); }
    };
    wrap.onclick = async () => {
      // ETH -> WETH on Sepolia: call WETH.deposit() (selector 0xd0e30db0) with value.
      try {
        const a = await ethereum.request({ method: 'eth_accounts' });
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{
          from: a[0],
          to: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', // canonical Sepolia WETH
          value: '0x38d7ea4c68000', // 0.001 ETH
          data: '0xd0e30db0',        // deposit()
        }]});
        set('wrap:' + hash);
      } catch (e) { set('wrap-error:' + (e.code||'') + ':' + e.message); }
    };
  </script>
</body></html>`);
});

// Minimal login SUT for exercising the login-flow + secrets pipeline locally.
// Valid credentials: any username + password "s3cr3t-pass". Wrong password → error.
/**
 * Known defects the fixture can be asked to exhibit.
 *
 * A suite's detection power cannot be measured against a product with no bugs: every case
 * passes and precision/recall have nothing to divide. So the fixture can be told to break
 * in a specific, documented way — the standard fault-injection trick — and the suite is
 * scored on whether the cases that *should* catch that fault actually do.
 */
export const DEFECTS: Record<string, { title: string; breaks: string }> = {
  "no-error": {
    title: "wrong credentials are rejected silently",
    breaks: "any case asserting the text 'Invalid username or password'",
  },
  "empty-user-ok": {
    title: "an empty username is accepted",
    breaks: "the empty-username boundary cases",
  },
  "no-welcome": {
    title: "the dashboard omits the welcome line",
    breaks: "cases asserting 'Welcome, <user>'",
  },
  "stale-error": {
    title: "the error message survives a successful login",
    breaks: "cases asserting the error disappears after logging in",
  },
  "logout-keeps-input": {
    title: "logging out leaves the username in the form",
    breaks: "cases asserting the form is empty after logout",
  },
};

app.get("/api/defects", (_req, res) => res.json({ defects: DEFECTS }));

app.get("/testlogin", (req, res) => {
  // `?defect=<id>` injects one known fault. Without it the fixture is healthy, which is
  // the other half of the measurement: a case that fails on the healthy app is a false alarm.
  const defect = String(req.query.defect || "");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>TestLogin</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:420px">
  <h1>Acme Portal — Sign in</h1>
  <div id="app">
    <label>Username<br><input id="username" style="width:100%;padding:8px;margin:6px 0"></label><br>
    <label>Password<br><input id="password" type="password" style="width:100%;padding:8px;margin:6px 0"></label><br>
    <button id="login" style="padding:10px 16px;font-size:16px;margin-top:8px">Sign in</button>
    <p id="error" style="color:#dc2626"></p>
  </div>
  <div id="dashboard" style="display:none">
    <h2 data-testid="welcome">Welcome, <span id="who"></span> 👋</h2>
    <p>Your dashboard is ready.</p>
    <button id="logout">Log out</button>
  </div>
  <script>
    const DEFECT = ${JSON.stringify(defect)};
    const $ = (id) => document.getElementById(id);
    $('login').onclick = () => {
      const u = $('username').value.trim();
      const p = $('password').value;
      const userOk = DEFECT === 'empty-user-ok' ? true : !!u;
      if (userOk && p === 's3cr3t-pass') {
        $('who').textContent = u;
        if (DEFECT === 'no-welcome') document.querySelector('[data-testid=welcome]').style.display = 'none';
        $('app').style.display = 'none';
        $('dashboard').style.display = 'block';
        if (DEFECT !== 'stale-error') $('error').textContent = '';
      } else {
        $('error').textContent = DEFECT === 'no-error' ? '' : 'Invalid username or password';
      }
    };
    $('logout').onclick = () => {
      if (DEFECT === 'logout-keeps-input') {
        $('dashboard').style.display = 'none';
        $('app').style.display = 'block';
        $('error').textContent = '';
        return; // the inputs keep their values
      }
      location.reload();
    };
  </script>
</body></html>`);
});

// Flaky SUT: the FIRST load for a given id renders an error ("warming up"); every
// subsequent load renders READY. Lets us exercise self-heal deterministically — the
// first attempt fails, the cache-busted retry passes → the run is marked "healed".
const flakyHits: Record<string, number> = {};
app.get("/testflaky", (req, res) => {
  const id = String(req.query.id || "default");
  flakyHits[id] = (flakyHits[id] || 0) + 1;
  const ready = flakyHits[id] > 1;
  const state = ready ? "READY" : "ERROR: service warming up";
  const color = ready ? "#16a34a" : "#dc2626";
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Flaky SUT</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>Flaky service</h1>
  <p>Health status:</p>
  <pre data-testid="status" style="font-size:20px;color:${color}">${state}</pre>
</body></html>`);
});

// Full wallet-connect + sign smoke test against the built-in test dapp (headed).
app.post("/api/wallet/dapp-test", async (req, res) => {
  const url = (req.body?.url as string) || `http://localhost:${PORT}/testdapp`;
  try {
    res.json(await diagnoseOnRunner("walletDappTest", { url }));
  } catch (e) {
    failJson(res, 500, e);
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    // Which instance this is. During a self-test two gateways are up at once, and a
    // screenshot of the wrong one is otherwise indistinguishable from the right one.
    instance: INSTANCE,
    model: resolveModelConfig().modelName,
    walletInstalled: isWalletInstalled(),
    walletOnboarded: isWalletOnboarded(),
    testAccount: isWalletOnboarded() ? TEST_ACCOUNT : undefined,
    chain: resolveChainConfig(),
  });
});

// Current chain config for the injected-wallet dapp-testing mode (RPC is configurable via
// CHAIN_RPC_URL / CHAIN_ID env, or overridden per request).
app.get("/api/config", (_req, res) => {
  res.json({ chain: resolveChainConfig(), account: TEST_ACCOUNT });
});

// Update the chain/RPC config at runtime (from the Model config page).
app.post("/api/config", (req, res) => {
  const rpcUrl = req.body?.rpcUrl as string | undefined;
  const chainId =
    req.body?.chainId !== undefined ? Number(req.body.chainId) : undefined;
  if (rpcUrl !== undefined && !/^https?:\/\//.test(rpcUrl)) {
    return res.status(400).json({ error: "rpcUrl must be an http(s) URL" });
  }
  if (chainId !== undefined && (!Number.isInteger(chainId) || chainId <= 0)) {
    return res.status(400).json({ error: "chainId must be a positive integer" });
  }
  const chain = setChainConfig({ rpcUrl, chainId });
  res.json({ chain, account: TEST_ACCOUNT });
});

// Proof of the injected-wallet capability (no model, no MetaMask): open a dapp with a virtual
// wallet pointed at the configured RPC, connect, send a real tx, verify the receipt on-chain.
app.post("/api/dapp/verify", async (req, res) => {
  const chain = resolveChainConfig({ rpcUrl: req.body?.rpcUrl, chainId: req.body?.chainId });
  const url = req.body?.url || `http://localhost:${PORT}/testdapp`;
  try {
    // Runs on a runner: it opens a browser, and every browser in this system belongs there.
    res.json(await diagnoseOnRunner("verifyDapp", { url, chain }));
  } catch (e) {
    failJson(res, 500, e);
  }
});

// Verify the wallet extension loads: launch with it, resolve its id, screenshot its UI.
app.post("/api/wallet/check", async (req, res) => {
  try {
    const result = await diagnoseOnRunner<{ installed: boolean; error?: string }>(
      "checkWallet",
      (req.body?.path as string) || "home.html",
    );
    if (!result.installed) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    failJson(res, 500, e);
  }
});

/**
 * 生效中的模型配置。**永不回密钥，也永不回 `****`。**
 *
 * 「永不回 `****`」这一条是有来历的：此前界面把 `MIDSCENE_MODEL_API_KEY=****`
 * 拼进一段可复制的 env 文本，粘进 `server/.env` 之后每一次调用都 401，
 * 而 401 读起来像模型服务坏了。**界面永远不交出它拿不到的东西。**
 *
 * `sources` 逐字段说明这一项来自落盘 / env / 默认——落盘优先于 env，
 * 所以「我改了 .env 怎么没反应」是这次改造必然会制造的一类困惑，
 * 唯一的解法是把它说出来，而不是让人去猜优先级。
 */
app.get("/api/model/config", (_req, res) => {
  const r = resolveModelRuntime();
  const meta = describeModelConfig();
  res.json({
    effective: {
      baseUrl: r.baseUrl,
      modelName: r.modelName,
      think: !r.noThink,
      thinkBudget: r.thinkBudget ?? null,
      timeoutMs: r.timeoutMs ?? null,
      useQwenVL: r.useQwenVL,
    },
    sources: r.sources,
    apiKey: meta.apiKey,
    savedAt: meta.saved.updatedAt ?? null,
    /**
     * 执行层（runner）里 Midscene 打的地址**可能不是这里显示的那个**：
     * `MIDSCENE_PROXY_URL` 在 runner 的 baseUrl 上是第一优先级。
     * 不说出来的话，这次改造只是把误诊挪了个位置。
     */
    proxyInUse: process.env.MIDSCENE_PROXY_URL || null,
  });
});

/**
 * 存一份模型配置。
 *
 * **字段白名单 + 逐项校验**，而不是把 `req.body` 原样塞进去——
 * 设置那条路上就有一个反例（`patch.prompts = req.body.prompts` 不校验 key，
 * 任意键都会永久落进 settings.json）。
 */
app.post("/api/model/config", (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof saveModelConfig>[0] = {};
  try {
    if (b.baseUrl !== undefined) {
      const v = String(b.baseUrl).trim();
      if (v && !/^https?:\/\//.test(v)) throw new Error("baseUrl 必须以 http:// 或 https:// 开头");
      patch.baseUrl = v;
    }
    if (b.modelName !== undefined) patch.modelName = String(b.modelName).trim();
    if (b.think !== undefined) patch.think = !!b.think;
    if (b.useQwenVL !== undefined) patch.useQwenVL = !!b.useQwenVL;
    for (const k of ["thinkBudget", "timeoutMs"] as const) {
      if (b[k] === undefined) continue;
      if (b[k] === "" || b[k] === null) {
        (patch as Record<string, unknown>)[k] = "";
        continue;
      }
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${k} 必须是正整数`);
      (patch as Record<string, unknown>)[k] = n;
    }
    // 三态：不传 = 不动；空串 = 清除落盘密钥回落 env；非空 = 加密写入。
    if (b.apiKey !== undefined) patch.apiKey = String(b.apiKey);

    saveModelConfig(patch);
    res.json({
      ok: true,
      /**
       * agent / runner 是在 spawn 那一刻拿到 env 快照的，所以它们要重启才生效。
       * **不自动重启**：重启 agent 会 abort 正在跑的图，那是一个人该做的决定。
       */
      legacy: true,
      appliesTo: "legacy-probe-only",
      modelProfilesPath: "/api/projects/:projectId/model-profiles",
      needsRestart: [],
      activeRuns: activeRuns().length,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/model/test", async (req, res) => {
  const result = await probeModel(req.body ?? {});
  res.json(result);
});

// Generate runnable Midscene code from natural-language steps.
app.post("/api/generate-code", async (req, res) => {
  const { title = "", steps = [], expected = "" } = req.body ?? {};
  try {
    const code = await generateCode(title, steps, expected);
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Execute a test case with Midscene against a live URL.
app.post("/api/run", async (req, res) => {
  const {
    url,
    steps = [],
    expected = "",
    oracle,
  }: { url?: string; steps?: string[]; expected?: string; oracle?: unknown } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url is required" });
  const injected = req.body?.provider === "injected" || !!req.body?.injected;
  guardRun(url, steps);
  const { pngPaths, sinceMs: _s, ...rest } = await execOnRunner({
    execId: `adhoc-${Date.now()}`,
    url,
    steps,
    expected,
    artifactDir: ARTIFACT_DIR,
    opts: {
      injected,
      wallet: !!req.body?.wallet,
      rpcUrl: req.body?.rpcUrl,
      chainId: req.body?.chainId,
      // A one-off run can carry a machine-checkable oracle too — it is the cheapest way to
      // see what the runner would settle without a model.
      oracle: oracle ? (MachineOracleSchema.parse(oracle) as never) : undefined,
    },
  });
  const result = { ...rest, screenshots: toDataUrls(readPngs(pngPaths)) };
  void _s;
  res.json(result);
});

/* ─────────────── Persistence: projects / cases / runs ─────────────── */

/**
 * 项目列表，每个带上它看板上有多少条用例。
 *
 * 卡片上原本那行「打开测试用例」是一个不存在的第二个动作：整张卡是一个按钮，点哪儿都
 * 是进入工作台。一个说得像按钮的东西如果不是按钮，读的人要试一次才知道。换成条数——
 * 那是一个事实，而且正好是决定要不要进这个项目时最想先知道的一件事。
 */
app.get("/api/projects", async (_req, res) =>
  res.json({
    projects: listProjects().map((p) => ({ ...p, cases: listCases(p.id).length })),
    // 两套账各带各的标签。合成一个数是更糟的做法：那会让「40 条用例」这句话继续骗人，
    // 只是骗得更圆滑。见 overview.ts 的注释。
    overviews: await allProjectOverviews(),
  }));

/** 单个项目的两套账。项目首屏用它。 */
app.get("/api/projects/:id/overview", async (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try {
    res.json(await projectOverview(req.params.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
const PLATFORMS = ["web", "ios", "android"] as const;
type Platform = (typeof PLATFORMS)[number];
const asPlatform = (v: unknown): Platform | undefined =>
  PLATFORMS.includes(v as Platform) ? (v as Platform) : undefined;

const validExploration = (body: { explorationMaxScreens?: unknown; explorationScope?: unknown }) =>
  (body.explorationMaxScreens === undefined || (Number.isInteger(body.explorationMaxScreens) && Number(body.explorationMaxScreens) >= 0 && Number(body.explorationMaxScreens) <= 50)) &&
  (body.explorationScope === undefined || ['current-url', 'rules'].includes(String(body.explorationScope)));
const asMaterials = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

app.post("/api/projects", (req, res) => {
  const { name, targetUrl, targetPlatform, materials, explorationMaxScreens, explorationScope } = req.body ?? {};
  if (!validExploration(req.body ?? {})) return res.status(400).json({ error: "invalid exploration settings" });
  if (!name || !targetUrl) return res.status(400).json({ error: "name and targetUrl required" });
  if (targetPlatform !== undefined && !asPlatform(targetPlatform))
    return res.status(400).json({ error: `targetPlatform must be one of ${PLATFORMS.join(", ")}` });
  res.json({
    project: createProject(
      String(name),
      String(targetUrl),
      asPlatform(targetPlatform) ?? "web",
      asMaterials(materials), explorationMaxScreens, explorationScope,
    ),
  });
});
// Renaming, re-pointing, or switching ends. Switching to iOS/Android does not delete the
// web3 settings already on the cases: it hides the controls, and switching back finds them
// where they were. Silently dropping a user's configuration on a dropdown change would be
// a worse surprise than a hidden field.
app.patch("/api/projects/:id", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const { name, targetUrl, targetPlatform } = req.body ?? {};
  if (!validExploration(req.body ?? {})) return res.status(400).json({ error: "invalid exploration settings" });
  if (targetPlatform !== undefined && !asPlatform(targetPlatform))
    return res.status(400).json({ error: `targetPlatform must be one of ${PLATFORMS.join(", ")}` });
  const project = updateProject(req.params.id, {
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(targetUrl !== undefined ? { targetUrl: String(targetUrl) } : {}),
    ...(targetPlatform !== undefined ? { targetPlatform: asPlatform(targetPlatform)! } : {}),
    ...(req.body?.explorationMaxScreens !== undefined ? { explorationMaxScreens: req.body.explorationMaxScreens } : {}),
    ...(req.body?.explorationScope !== undefined ? { explorationScope: req.body.explorationScope } : {}),
    ...(req.body?.materials !== undefined ? { materials: asMaterials(req.body.materials) } : {}),
  });
  res.json({ project });
});
/**
 * 项目级规则包（docs/v3/history/24 §19）。
 *
 * 以前它只能在新建运行的表单里贴一次、躺在那次运行里。规则包是这个产品最主要的领域资产，
 * 却是唯一没有列表、没有版本、没有复用的那一个——同一个项目的两次运行可以用着不同的包
 * 而没人拦得住。这四条路由把它变成项目的东西：列出来、看得见、传新版、删没用过的。
 */
app.get("/api/projects/:id/rule-packs", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  res.json({ packs: listRulePacks(req.params.id) });
});
app.get("/api/projects/:id/rule-packs/:hash", (req, res) => {
  try { res.json({ pack: readRulePack(req.params.id, req.params.hash) }); }
  catch (e) { res.status((e as { status?: number }).status ?? 500).json({ error: String((e as Error).message) }); }
});
app.post("/api/projects/:id/rule-packs", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try { res.json(saveRulePack(req.params.id, req.body?.pack ?? req.body)); }
  catch (e) { res.status((e as { status?: number }).status ?? 400).json({ error: String((e as Error).message) }); }
});
app.delete("/api/projects/:id/rule-packs/:hash", (req, res) => {
  try { deleteRulePack(req.params.id, req.params.hash); res.json({ ok: true }); }
  catch (e) { res.status((e as { status?: number }).status ?? 500).json({ error: String((e as Error).message) }); }
});

/**
 * 项目级领域参考：和规则包一个待遇——按内容哈希存版本、运行开始时冻结绑定、用过的版本不能删。
 */
app.get("/api/projects/:id/domain-references", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  res.json({ references: listDomainReferences(req.params.id) });
});
app.get("/api/projects/:id/domain-references/:hash", (req, res) => {
  try { res.json({ reference: readDomainReference(req.params.id, req.params.hash) }); }
  catch (e) { res.status((e as { status?: number }).status ?? 500).json({ error: String((e as Error).message) }); }
});
app.post("/api/projects/:id/domain-references", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try { res.json(saveDomainReference(req.params.id, req.body ?? {})); }
  catch (e) { res.status((e as { status?: number }).status ?? 400).json({ error: String((e as Error).message) }); }
});
app.delete("/api/projects/:id/domain-references/:hash", (req, res) => {
  try { res.json(deleteDomainReference(req.params.id, req.params.hash)); }
  catch (e) { res.status((e as { status?: number }).status ?? 500).json({ error: String((e as Error).message) }); }
});
app.delete("/api/projects/:id", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  deleteProject(req.params.id);
  res.json({ ok: true });
});

// One-click Uniswap dapp-testing example: a project pointed at the real Uniswap app with
// starter web3 cases (injected wallet + on-chain assertions). Reused if it already exists.
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
app.post("/api/examples/uniswap", (_req, res) => {
  const existing = listProjects().find((p) => p.name === "Uniswap (example)");
  if (existing) return res.json({ project: existing, reused: true });
  const project = createProject("Uniswap (example)", "https://app.uniswap.org/swap");
  // 1) Wallet connects — works out of the box (injected wallet auto-connects via EIP-6963).
  createCase({
    projectId: project.id,
    title: "Wallet connects to Uniswap",
    priority: "P0",
    type: "e2e",
    priorityReason: "The injected wallet auto-connects to Uniswap via EIP-6963 — verify the app shows it.",
    steps: [],
    expected:
      "The Uniswap swap page is loaded and the connected wallet address (an account like 0x…) is shown in the top-right; the swap form with a 'You pay' / 'You receive' layout is visible",
    web3Mode: "injected",
    chainAssertions: [],
  });
  // 2) Swap template with an ON-CHAIN assertion — the recommended dapp pattern. NOTE: against
  // Uniswap's PRODUCTION app on a fork the UI reads balances from Uniswap's backend gateway
  // (not the fork), so the UI swap may show "insufficient funds"; point this at your own
  // deployment / a provider-reading UI, or rely on the on-chain assertion.
  createCase({
    projectId: project.id,
    title: "Swap 0.01 ETH → USDC (on-chain verified)",
    priority: "P0",
    type: "e2e",
    priorityReason:
      "Template for a swap verified on-chain (USDC balance rose). On a fork, Uniswap's prod UI reads balances from its own backend — use your own RPC/deployment for a full UI swap.",
    steps: [
      { order: 1, text: "In the 'You pay' amount field, enter 0.01" },
      { order: 2, text: "Open the 'You receive' token selector, search USDC, and select it" },
      { order: 3, text: "Click the Swap button, then confirm the swap" },
    ],
    expected: "A swap confirmation or success state is shown (e.g. 'Swap submitted' / a success toast)",
    web3Mode: "injected",
    chainAssertions: [
      { kind: "erc20Balance", op: "increased", token: USDC_MAINNET, decimals: 6, label: "USDC balance increased after the swap" },
    ],
  });
  res.json({ project, reused: false });
});

app.get("/api/cases", (req, res) =>
  res.json({ cases: listCases(req.query.projectId as string | undefined) }),
);
app.post("/api/cases", (req, res) => {
  const { projectId, title } = req.body ?? {};
  if (!projectId || !title) return res.status(400).json({ error: "projectId and title required" });
  res.json({ case: createCase(req.body) });
});
app.patch("/api/cases/:id", (req, res) => {
  const before = getCase(req.params.id);
  if (!before) return res.status(404).json({ error: "case not found" });
  const body = (req.body ?? {}) as Record<string, unknown>;
  /**
   * 自愈退化（07 T-16）：一次「修复」把判据改弱、层级掉了、expected 变含糊，都要被叫出来。
   * `__actor: "agent"`（MCP / 自愈路径）改弱一律拒，回到人；人改弱放行但记账并把用例标 `degraded`，
   * 报表里看得见。规则在 `harness-testing/codegen/degrade.ts`，和代码用例那边的 `assertionWeakened` 同一个思路。
   */
  const { __actor: _ignoredActor, ...patch } = body;
  const d = degradeDecision(before, patch, requestPrincipal(req).kind);
  const findings = d.findings;
  if (findings.length) {
    recordDegrade({ caseId: before.id, projectId: before.projectId, actor: d.actor, blocked: d.block, findings: findings.map((f) => f.detail) });
    if (d.block)
      return res.status(409).json({ error: `自愈不允许改弱判据：${findings.map((f) => f.detail).join("；")}`, code: "DEGRADED", findings });
  }
  const c = updateCase(req.params.id, { ...patch, ...(findings.length ? { degraded: true } : {}) } as Parameters<typeof updateCase>[1]);
  if (!c) return res.status(404).json({ error: "case not found" });
  res.json({ case: c, ...(findings.length ? { degraded: findings } : {}) });
});
app.delete("/api/cases/:id", (req, res) => {
  deleteCase(req.params.id);
  res.json({ ok: true });
});

app.get("/api/runs", (req, res) => {
  const caseId = req.query.caseId as string | undefined;
  const projectId = req.query.projectId as string | undefined;
  const runs = caseId
    ? listRuns(caseId)
    : projectId
      ? listRunsByProject(projectId)
      : listRuns();
  res.json({ runs });
});

// A single run record (for drilling into a run from the suite view).
app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ run });
});

// Serve Midscene's full interactive HTML report for a run (for failure localization).
app.get("/api/runs/:id/report", (req, res) => {
  const run = getRun(req.params.id);
  if (!run?.reportPath || !existsSync(run.reportPath)) {
    return res.status(404).send("No Midscene report captured for this run.");
  }
  res.sendFile(run.reportPath);
});

// Approve the current image of a step as the new visual baseline (accept the change).
app.post("/api/cases/:id/baselines/approve", (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const stepIdx = Number(req.body?.stepIdx);
  const ref = String(req.body?.ref || "");
  if (!Number.isInteger(stepIdx) || !ref.startsWith("current/")) {
    return res.status(400).json({ error: "stepIdx and a current/* ref required" });
  }
  const src = resolve(ARTIFACT_DIR, ref);
  if (!existsSync(src)) return res.status(404).json({ error: "artifact not found" });
  const blPath = resolve(ARTIFACT_DIR, "baselines", `${c.id}-${stepIdx}.png`);
  copyFileSync(src, blPath);
  const baseline = upsertBaseline(c.id, stepIdx, blPath);
  res.json({ ok: true, baseline });
});

// Export a project's cases as a standalone runnable Playwright + Midscene project.
// ?format=json returns the file map; otherwise streams a .zip download.
/**
 * 下载之前的自检。
 *
 * 每一条都是**已经查过的事实**，不是一句提醒——「记得检查登录有没有带走」这种话
 * 谁都写得出来，而它对读的人没有任何帮助：他还是得自己去翻。
 * 这里回答的是：隔离的有几条、断言被改松的有几条、登录环节这次到底带没带走、
 * 环境的 query 参数有没有真的拼进 baseURL。
 */
app.get("/api/projects/:id/export-preflight", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const all = listCases(project.id);
  const envs = listEnvironments(project.id);
  const env = envs.find((e) => e.isDefault) ?? envs[0];

  const stale = supersededBoardCases(project.id);
  const quarantined = all.filter((c) => c.quarantined);
  const degraded = all.filter((c) => c.degraded);
  const superseded = all.filter((c) => stale.has(c.id));
  const noCode = all.filter((c) => !stale.has(c.id) && !c.code?.trim() && !c.steps.length);

  // 登录到底带没带走：看**生成出来的文件里**有没有那个 setup，而不是看环境上写着什么。
  const files = buildExportFiles(project, exportApprovedCases(all.filter(c => !stale.has(c.id) && !c.quarantined && !c.degraded)), {
    environments: envs,
    secretKeys: listSecretMeta(project.id).map((s) => s.key),
    // 抽取层只增不减：曾经命名过的步骤/前置一直保留名字，增量导出才不会搅动一批 spec。
    sticky: exportLayerMemory(project.id),
    onLayers: (seen) => rememberExportLayers(project.id, seen),
  });
  const authFile = Object.keys(files).find((f) => f.includes("auth.setup"));
  const configText = files["playwright.config.ts"] ?? "";
  const queryKeys = Object.keys(env?.query ?? {});
  /*
   * query 参数有没有真的拼进 baseURL。
   *
   * 这里查的是生成出来的 config 文本本身：环境上配着 `?lang=zh`，而 `baseURL` 那一行
   * 只写了 `defaultEnv.baseUrl`——导出的工程会打在一个没有这些参数的地址上，
   * 而症状是「本地跑得好好的，导出去就找不到元素」。
   */
  const queryCarried = queryKeys.length === 0 || queryKeys.every((k) => configText.includes(k));

  res.json({
    checks: [
      {
        id: "quarantined",
        ok: quarantined.length === 0,
        n: quarantined.length,
        cases: quarantined.map((c) => ({ id: c.id, title: c.title })),
        excludedByDefault: true,
      },
      {
        id: "degraded",
        ok: degraded.length === 0,
        n: degraded.length,
        cases: degraded.map((c) => ({ id: c.id, title: c.title })),
        excludedByDefault: true,
      },
      {
        id: "superseded",
        ok: superseded.length === 0,
        n: superseded.length,
        cases: superseded.map((c) => ({ id: c.id, title: c.title })),
        excludedByDefault: true,
        detail: superseded.length ? `板上有 ${superseded.length} 条绑在已被取代的修订上——同一条用例改过之后的上一版。它们不会被导出。` : "板上没有过期的旧修订",
      },
      { id: "noCode", ok: noCode.length === 0, n: noCode.length, cases: noCode.map((c) => ({ id: c.id, title: c.title })) },
      {
        id: "login",
        ok: !env?.login?.authRequired || !!authFile,
        detail: env?.login?.authRequired
          ? authFile
            ? `登录会随导出带走：${authFile}`
            : "这个环境声明了需要登录，但导出的工程里没有登录环节——它会以未登录状态跑"
          : "这个环境不需要登录",
      },
      {
        id: "query",
        ok: queryCarried,
        detail: queryKeys.length
          ? queryCarried
            ? `环境的 query 参数（${queryKeys.join(", ")}）在导出的配置里出现了`
            : `环境配了 query 参数（${queryKeys.join(", ")}），但导出的 baseURL 里没有它们——导出的工程会打在一个不带参数的地址上`
          : "这个环境没有 query 参数",
      },
    ],
  });
});

app.get("/api/projects/:id/export", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  /*
   * 默认把隔离的和断言被改松的排除掉。
   *
   * 两者都是**已知不可信**的用例：隔离的那条红不再拦门禁，改松的那条是靠删断言变绿的。
   * 把它们打进交给客户的工程，等于把这套东西最不该交出去的两样东西一起交出去。
   * `?include=all` 可以要回来——那是一个明确的决定，不是默认。
   */
  const includeAll = req.query.include === "all";
  /*
   * 绑在已被取代的修订上的板项一律排除，`include=all` 也不例外。
   *
   * 隔离与断言改松是「已知不可信，但你可以坚持要」，所以给了 `include=all` 这个出口；
   * 旧修订不是这种东西——它是同一条用例的上一版，带出去就是**同一条用例两个 spec**，
   * 其中一个跑的是已经被改掉的步骤。那不是一个可以由人选择要不要的东西，是错的。
   */
  const stale = supersededBoardCases(project.id);
  const cases = (includeAll
    ? listCases(project.id)
    : listCases(project.id).filter((c) => !c.quarantined && !c.degraded)).filter((c) => !stale.has(c.id));
  const files = buildExportFiles(project, exportApprovedCases(cases), {
    environments: listEnvironments(project.id),
    secretKeys: listSecretMeta(project.id).map((s) => s.key),
    // 抽取层只增不减：曾经命名过的步骤/前置一直保留名字，增量导出才不会搅动一批 spec。
    sticky: exportLayerMemory(project.id),
    onLayers: (seen) => rememberExportLayers(project.id, seen),
  });

  if (req.query.format === "json") return res.json({ files });

  const dir = mkdtempSync(join(tmpdir(), "tp-export-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync("zip", ["-r", "-q", "export.zip", ".", "-x", "export.zip"], { cwd: dir });
    const zipName = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-e2e.zip";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    const stream = createReadStream(join(dir, "export.zip"));
    stream.pipe(res);
    stream.on("close", () => rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: (e as Error).message });
  }
});

// Generate code for a stored case and persist it.
app.post("/api/cases/:id/generate-code", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  try {
    const { code } = { code: await generateCode(c.title, c.steps.map((s) => s.text), c.priorityReason, c.projectId) };
    const updated = updateCase(c.id, { code, hasCode: true });
    res.json({ case: updated });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Bust the Midscene plan cache for a case → the next run replans instead of
// replaying a stale plan. This is the self-heal mechanism for selector/visual drift.
function bustCache(cacheId: string): void {
  const f = resolve(MIDSCENE_DIR, "cache", `${cacheId}.cache.yaml`);
  try {
    if (existsSync(f)) rmSync(f);
  } catch {
    /* ignore */
  }
}

// Run one case once (env/secret/login resolution, perf, oracle, report, visual), persist a run.
async function runAndPersistCase(
  c: TestCase,
  body: Record<string, any>,
): Promise<RunRecord> {
  // Validate a managed run's project binding before reset commands or browser actions.
  if (body?.modelSnapshotRunId !== undefined) {
    if (typeof body.modelSnapshotRunId !== "string" || !body.modelSnapshotRunId) throw new Error("invalid_model_snapshot_run_id");
    const { snapshotExecutor } = await import("./modelSnapshots.js");
    snapshotExecutor(body.modelSnapshotRunId, c.projectId);
  }
  const project = getProject(c.projectId);
  const env = resolveEnvironment(c.projectId, body?.env || c.envRef);
  const ctx: ResolveContext = {
    env: env?.vars ?? {},
    secrets: getSecretValues(c.projectId),
    row: body?.__row, // data-driven: current row → ${row} / ${row.col}
  };
  const url = resolveText(body?.url || env?.baseUrl || project?.targetUrl || "", ctx);
  if (!url) throw new Error("no url (set an environment baseUrl or project targetUrl)");
  // Login state: if a session was captured, INJECT it and skip the login steps (fast,
  // best-practice). Otherwise fall back to running the UI login flow.
  const session = env?.login?.session ?? null;
  const useSession = !!env?.login?.authRequired && !!session && !body?.skipLogin;
  const login =
    env?.login?.authRequired && !body?.skipLogin ? env.login.steps ?? [] : [];
  // Wallet mode: from the run body OR the case's web3Mode (so suite/debug honor it too).
  const injected = body?.provider === "injected" || !!body?.injected || c.web3Mode === "injected";
  const wallet = !!body?.wallet || c.web3Mode === "metamask";
  // Dapp run: resolve the chain + on-chain assertions when the case is a web3 case.
  const chainCfg = resolveChainConfig({ rpcUrl: body?.rpcUrl, chainId: body?.chainId });
  const web3 =
    c.web3Mode || (c.chainAssertions && c.chainAssertions.length)
      ? {
          chainAssertions: c.chainAssertions ?? [],
          rpcUrl: chainCfg.rpcUrl,
          account: TEST_ACCOUNT,
          settleMs: 4000,
        }
      : undefined;

  guardRun(url, [...login, ...c.steps.map((s) => s.text), ...c.postSteps.map((s) => s.text)], { sideEffectLabels: currentRulePack(c.projectId)?.sideEffectLabels });
  /**
   * 环境级复位（07 T-28 验收 ②）：`vars.TP_RESET_CMD` 在每条用例跑之前执行一次，输出记进这次运行的日志。
   * teardown 是模型做的、会失手；失手一次，后面每条的判据都被残留状态带偏（实测一次连带三条）。
   * 复位不走模型：hyperliquid 基准用的是自签 L1 动作的 `cancel-all.mjs --flatten`。没配就什么都不做。
   */
  if (body?.expected !== undefined && body.expected !== c.expected) throw new Error("test_intent_frozen");
  assertBoardApproval(c, body);
  const reviewedExecution=exportApprovedCases([c])[0];
  if('lifecycle' in reviewedExecution && reviewedExecution.lifecycle)throw new LedgerError(409,'lifecycle_requires_workflow_execution');
  const resetLog = runEnvReset(env?.vars?.TP_RESET_CMD);
  const exec = await execOnRunner({
    execId: `${c.id}-${Date.now()}`,
    scopeProjectId: c.projectId,
    ...(typeof body?.modelSnapshotRunId === "string" ? { modelSnapshotRunId: body.modelSnapshotRunId } : {}),
    url,
    steps: c.steps.map((s) => s.text),
    expected: body?.expected || c.expected || "",
    // Same verdict on the board as in the workflow: a case that a program can settle is
    // settled by one wherever it runs.
    artifactDir: ARTIFACT_DIR,
    opts: {
      injected,
      wallet,
      rpcUrl: body?.rpcUrl,
      chainId: body?.chainId,
      cacheId: c.id + (body?.__cacheSuffix ?? ""), // per-row cache so data-driven rows don't collide
      // 批次给的 key：同一批的用例共用一个浏览器，登录态只跑一次（07 T-28）。单跑没有。
      ...(typeof body?.__sessionKey === "string" ? { sessionKey: body.__sessionKey } : {}),
      login,
      authentication: env?.login?.authRequired && !body?.skipLogin ? { sessionChecks: env.login.sessionChecks, injectedSessionCheck: env.login.injectedSessionCheck } : undefined,
      web3,
      postSteps: c.postSteps.map((s) => s.text),
      resolve: ctx,
      rowLabel: body?.__rowLabel,
      // Fixed headers + any auth header captured by API login (when the session is used).
      extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(useSession ? session?.headers ?? {} : {}) },
      query: resolveMap(env?.query ?? {}, ctx),
      storageState: useSession ? session : null,
      oracle: c.oracle,
      /*
       * 视口跟着环境走——探索那条路早就这么做了（`observeLaunch`），跑用例这条路一直没传，
       * 于是同一个被测对象探索时是 1440 宽、真跑时退回 1024：交易页的下单面板在窄视口下
       * 整块不渲染，用例会在「找不到 Size 输入框」上失败，而那不是产品的错。
       */
      ...(env?.viewport?.width || env?.viewport?.height ? { viewport: env.viewport } : {}),
    },
  });
  // Pixels come back as files; the gateway is the only side that knows the baselines.
  const pngBuffers = readPngs(exec.pngPaths);
  const result = { ...exec, pngBuffers, screenshots: toDataUrls(pngBuffers) };

  /*
   * 性能预算传进去，不再传 `{}`。
   *
   * `comparePerf` 一直支持它（超预算即判回归），但调用处一直给的是空对象，
   * 于是只有 `DEFAULT_BUDGETS` 生效、而且没有任何地方配得到——AC-11 的
   * 「与基线**和预算**比对」看起来像没做，其实是接线没接上。
   *
   * 两条线各管一件事：基线保「别变得更慢」，预算保「本来就不该这么慢」。
   */
  const perf = comparePerf(result.perfMetrics, getPerfBaseline(c.id), config.perfBudget);
  if (perf.status === "new_baseline" && Object.keys(result.perfMetrics).length > 0) {
    upsertPerfBaseline(c.id, result.perfMetrics);
  }
  if (resetLog) result.logs.unshift(...resetLog);
  const run = createRun({
    caseId: c.id,
    caseTitle: c.title,
    // Stored rather than left to the join: the ledger has to scope rows whose case may not
    // exist (workflow candidates), so every row carries its own project.
    projectId: c.projectId,
    priority: c.priority,
    status: result.status,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    failureReason: result.failureReason,
    logs: result.logs,
    screenshots: result.screenshots,
    oracle: result.oracle,
    perf,
    infraError: result.infraError,
    failCode: result.failure?.code,
    failKind: result.failure?.attribution,
  });
  // 账从跑这条的 runner 自己的目录读：一个 runner 一次只跑一条，它的日志就是这条的账（07 T-04）。
  // 目录还没建出来（老的 runner、没跑过）就退回共享目录 + 时间窗，并把 attribution 标成 window。
  const runnerDir = midsceneDirFor(result.runnerId);
  const perRunner = existsSync(resolve(runnerDir, "log"));
  const report = captureMidsceneReport({
    midsceneDir: perRunner ? runnerDir : MIDSCENE_DIR,
    sinceMs: result.sinceMs,
    // 窗口收口在这次运行结束的时刻：单并发时和不给一样；并发 > 1 时至少不把后面的运行算进来。
    untilMs: result.sinceMs + result.durationMs + 1000,
    destPath: resolve(ARTIFACT_DIR, "reports", `${run.id}.html`),
  });
  const visual = processVisual(c.id, run.id, result.pngBuffers);
  // 分段墙钟由 runner 量（它知道每段从哪到哪），账由日志读（它知道模型花了什么）；这里合成一份。
  const spend = report.spend
    ? { ...report.spend, attribution: perRunner ? ("runner" as const) : ("window" as const), ...(result.phases ? { phases: result.phases } : {}) }
    : undefined;
  updateRunResults(run.id, { reportPath: report.reportPath, tokens: report.tokens, spend, visual, perf, oracle: result.oracle });
  run.reportPath = report.reportPath;
  run.tokens = report.tokens;
  run.spend = report.spend;
  run.visual = visual;
  return run;
}

// Run a case with self-heal: on failure, bust the plan cache and retry up to maxRetries.
// The final run is tagged attempts + healed; per-case flakiness is recomputed.
async function runCaseWithHeal(
  c: TestCase,
  body: Record<string, any>,
  maxRetries: number,
): Promise<{ run: RunRecord; attempts: number; healed: boolean }> {
  updateCase(c.id, { runStatus: "running" as RunStatus });
  let attempts = 0;
  let run: RunRecord;
  for (;;) {
    attempts++;
    run = await runAndPersistCase(c, body);
    if (run.status === "passed" || attempts > maxRetries) break;
    bustCache(c.id + (body?.__cacheSuffix ?? "")); // self-heal: drop the stale (per-row) plan
  }
  const healed = run.status === "passed" && attempts > 1;
  updateRunHealing(run.id, attempts, healed);
  run.attempts = attempts;
  run.healed = healed;
  computeFlakiness(c.id);
  updateCase(c.id, { runStatus: run.status });
  return { run, attempts, healed };
}

// Data-driven wrapper: if the case binds an env array var (dataKey) with ≥1 rows, run it
// once per row (each row injected as ${row}/${row.col}, with its own plan cache), and
// report the aggregate — the case passes only if EVERY row passes. Otherwise a single run.
async function runCaseDataDriven(
  c: TestCase,
  body: Record<string, any>,
  maxRetries: number,
): Promise<{ run: RunRecord; attempts: number; healed: boolean; rows?: number; rowsPassed?: number }> {
  const env = resolveEnvironment(c.projectId, body?.env || c.envRef);
  /**
   * 数据先找**数据集**，找不到再退回环境变量里的数组。
   *
   * 退回那一支是为了兼容：`dataKey` 本来就指向 `env.vars[k]`，已有的用例还绑在那儿。
   * 但新的数据应该进数据集——环境变量是「这个环境怎么连」，数据是「拿什么去试」，
   * 两件事混在一个口袋里，改哪个都要担心碰到另一个。
   */
  const ds = c.dataKey ? getDataset(c.projectId, c.dataKey) : undefined;
  const envArr = c.dataKey ? env?.vars?.[c.dataKey] : undefined;
  const raw = ds?.rows ?? (Array.isArray(envArr) ? envArr : null);
  if (!raw || !raw.length) return runCaseWithHeal(c, body, maxRetries);
  /**
   * 标了唯一的列，这一次运行整批加同一个后缀。
   *
   * 同一批用同一个后缀，是为了让同一次运行里的多行仍然可以互相引用；
   * 而两次运行后缀不同，第二遍才不会撞唯一约束——「跑第二遍撞已存在」是 E2E 最常
   * 复发的一种失败，而它每次看起来都像产品坏了。
   */
  const suffix = runSuffix();
  const rows = ds?.uniqueCols.length ? ds.rows.map((r) => uniquify(r, ds.uniqueCols, suffix)) : raw;

  let last: { run: RunRecord; attempts: number; healed: boolean } | undefined;
  let passed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `${i + 1}/${rows.length}: ${typeof row === "object" ? JSON.stringify(row) : String(row)}`;
    last = await runCaseWithHeal(
      c,
      { ...body, __row: row, __cacheSuffix: `#${i}`, __rowLabel: label },
      maxRetries,
    );
    if (last.run.status === "passed") passed++;
  }
  const allPassed = passed === rows.length;
  updateCase(c.id, { runStatus: allPassed ? "passed" : "failed" });
  // The immediate API response reflects the AGGREGATE; each row's run is persisted on its own.
  return {
    ...last!,
    run: { ...last!.run, status: allPassed ? "passed" : "failed" },
    rows: rows.length,
    rowsPassed: passed,
  };
}

// Edit-time AI node intervention: propose a change to a case's steps or oracle from a
// natural-language instruction. Returns { current, proposed } for a diff preview — does NOT
// mutate. The client applies it via PATCH /api/cases/:id only if the user accepts.
app.post("/api/cases/:id/refine", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const rt = req.body?.target;
  const target: "steps" | "oracle" | "data" =
    rt === "oracle" ? "oracle" : rt === "data" ? "data" : "steps";
  const instruction = String(req.body?.instruction || "").trim();
  if (!instruction) return res.status(400).json({ error: "instruction is required" });
  try {
    const result = await refineCase({
      title: c.title,
      steps: c.steps.map((s) => s.text),
      expected: c.expected || "",
      type: c.type,
      target,
      instruction,
      stepIdx: typeof req.body?.stepIdx === "number" ? req.body.stepIdx : undefined,
      lang: typeof req.body?.lang === "string" ? req.body.lang : undefined,
    }, c.projectId);
    // "data" edits the step list too, so it diffs against steps like the "steps" target.
    const editsSteps = target === "steps" || target === "data";
    const current = editsSteps
      ? { steps: c.steps.map((s) => s.text) }
      : { expected: c.expected || "" };
    const proposed = editsSteps
      ? { steps: result.proposedSteps ?? [] }
      : { expected: result.proposedExpected ?? "" };
    res.json({ target, current, proposed, note: result.note });
  } catch (e) {
    res.status(502).json({ error: `refine failed: ${(e as Error).message}` });
  }
});

// Visual step-by-step debug (SSE). Runs the case live, streaming one event per step
// (screenshot + action + status), stops on the first failure, and does NOT persist a run
// (debugging is exploratory). An optional ?hint= is injected as agent action-context —
// human-in-the-loop steering for a guided re-run. Secrets are resolved for execution but
// only the redacted TEMPLATE text is streamed. EventSource is GET-only → params via query.
app.get("/api/cases/:id/debug", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (evt: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // Everything that needs the database is resolved here; the session itself runs on a
  // runner and streams its frames back over the event bus.
  const env = resolveEnvironment(c.projectId, String(req.query.env || c.envRef || ""));
  const ctx: ResolveContext = { env: env?.vars ?? {}, secrets: getSecretValues(c.projectId) };
  const url = resolveText(
    String(req.query.url || "") || env?.baseUrl || getProject(c.projectId)?.targetUrl || "",
    ctx,
  );
  const hint = String(req.query.hint || "").trim();
  // Same login-state policy as a real run: captured session → inject + skip login steps.
  const session0 = env?.login?.session ?? null;
  const useSession = !!env?.login?.authRequired && !!session0 && req.query.skipLogin !== "1";
  const doLogin = env?.login?.authRequired && !useSession && req.query.skipLogin !== "1";
  const loginSteps = doLogin ? env?.login?.steps ?? [] : [];
  // Honor the case's web3 mode so debugging a dapp case behaves like a real run
  // (inject the wallet), not a wallet-less page where provider is absent.
  const dbgInjected = c.web3Mode === "injected";
  const dbgChain = resolveChainConfig({});
  const launch = {
    injected: dbgInjected,
    wallet: c.web3Mode === "metamask",
    rpcUrl: dbgInjected ? dbgChain.rpcUrl : undefined,
    chainId: dbgInjected ? dbgChain.chainId : undefined,
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(useSession ? session0?.headers ?? {} : {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: useSession ? session0 : null,
  };
  const plan = [
    ...loginSteps.map((t) => ({ text: t, kind: "login" as const })),
    ...c.steps.map((s) => ({ text: s.text, kind: "step" as const })),
  ];

  const live = interactiveSession(`dbg-${c.id}`, c.projectId);
  const off = live.onFrame(send);
  let closed = false;
  req.on("close", () => {
    closed = true;
    off();
    void live.cancel();
  });

  try {
    if (!url) throw new Error("no url (set an environment baseUrl or project targetUrl)");
    guardRun(url, plan.map((p) => p.text), { sideEffectLabels: currentRulePack(c.projectId)?.sideEffectLabels });
    await live.debug(
      { url, plan, expected: c.expected || "", hint: hint || undefined, resolve: ctx, launch },
      ARTIFACT_DIR,
    );
  } catch (e) {
    // Dispatch failures only — a failing STEP is reported by the runner itself.
    if (!closed) send({ type: "done", status: "error", message: (e as Error).message });
  } finally {
    off();
    if (!closed && !res.writableEnded) res.end();
  }
});

// Execute a stored case (with optional self-heal retry), persist, update status.
app.post("/api/cases/:id/run", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  try {
    const maxRetries = Math.max(0, Number(req.body?.retries ?? 0));
    const { run, rows, rowsPassed } = await runCaseDataDriven(c, req.body ?? {}, maxRetries);
    res.json({ case: getCase(c.id), run, rows, rowsPassed });
  } catch (e) {
    updateCase(c.id, { runStatus: "failed" as RunStatus });
    failJson(res, 500, e);
  }
});

// Accept a run's current performance metrics as the new baseline for the case.
app.post("/api/cases/:id/perf-baseline/approve", (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const run = getRun(String(req.body?.runId || ""));
  const metrics = (run?.perf as { metrics?: PerfMetrics } | undefined)?.metrics;
  if (!metrics) return res.status(400).json({ error: "runId with perf metrics required" });
  upsertPerfBaseline(c.id, metrics);
  res.json({ ok: true, metrics });
});

interface Flow {
  title: string;
  priority: Priority;
  reason: string;
  steps: string[];
  expected?: string;
  type?: string;
  // Dapp explore: the model's suggested on-chain check for a state-changing flow.
  chain?: { kind?: string; op?: string; token?: string; decimals?: number; note?: string };
}
function asFlows(data: unknown): Flow[] {
  const arr = Array.isArray(data)
    ? data
    : ((data as { flows?: unknown[] })?.flows ?? []);
  return (arr as Flow[]).filter((f) => f && f.title);
}
// Map a dapp flow's `chain` hint → a concrete on-chain assertion for the case.
function flowChainAssertions(f: Flow): ChainAssertion[] {
  const c = f.chain;
  if (!c || !c.kind) return [];
  const op = (["increased", "decreased", "changed", "gte", "lte", "eq"].includes(c.op ?? "")
    ? c.op
    : "changed") as ChainAssertion["op"];
  const kind: ChainAssertion["kind"] = c.kind === "erc20Balance" ? "erc20Balance" : "nativeBalance";
  const a: ChainAssertion = { kind, op, label: c.note };
  if (kind === "erc20Balance" && c.token && /^0x[a-fA-F0-9]{40}$/.test(c.token)) {
    a.token = c.token;
    a.decimals = typeof c.decimals === "number" ? c.decimals : 18;
  }
  return [a];
}

// Explore a project's site and persist the discovered flows as cases.
// With { deep: true } it does an agentic crawl: advance one screen (log in / primary CTA)
// and re-query, so flows reached after the entry page are grounded in the real UI.
// Turn the model's raw flows into cases (dedup by title). Needs the DB, so it stays here.
function createCasesFromFlows(projectId: string, flows: unknown[], web3: boolean) {
  const seen = new Set(listCases(projectId).map((c) => c.title.toLowerCase()));
  const created = [];
  for (const f of asFlows(flows)) {
    const key = f.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    created.push(
      createCase({
        projectId,
        title: f.title,
        priority: (["P0", "P1", "P2"].includes(f.priority) ? f.priority : "P1") as Priority,
        priorityReason: f.reason || "",
        expected: f.expected || "",
        type: (CASE_TYPES.has(f.type ?? "") ? f.type : "functional") as TestCase["type"],
        steps: (f.steps || []).map((t, i) => ({ order: i + 1, text: t })),
        web3Mode: web3 ? "injected" : "",
        chainAssertions: web3 ? flowChainAssertions(f) : [],
      }),
    );
  }
  return created;
}

// The prompt pack for one explore: composed here because prompts are gateway settings.
function explorePrompts(deep: boolean, web3: boolean, lang?: string) {
  const { explore, exploreDeepPrefix, exploreDapp } = getSettings().prompts;
  const dir = langDirective(lang);
  const prompt = (web3 ? exploreDapp : explore) + dir;
  return { prompt, deepPrompt: deep ? exploreDeepPrefix + prompt : undefined };
}

/**
 * 打开被测产品时要带上的东西：环境变量解析后的固定头、查询参数、以及已捕获的登录态。
 *
 * 观察一个需要登录的产品，如果不带上会话，看到的永远是登录页——那样整理出来的规格会
 * 一本正经地宣称这个产品只有一个登录界面。
 */
/** 这个项目的登录步骤与占位符解析上下文。执行用例走的是同一套。 */
function observeLogin(projectId: string, envRef?: string): { login?: string[]; resolve?: ResolveContext } {
  const env = resolveEnvironment(projectId, envRef);
  const steps = env?.login?.steps ?? [];
  if (!steps.length) return {};
  return {
    login: steps,
    resolve: { env: env?.vars ?? {}, secrets: getSecretValues(projectId) },
  };
}

function observeLaunch(projectId: string, envRef?: string): {
  extraHeaders: Record<string, string>;
  query: Record<string, string>;
  storageState: StorageState | null;
  viewport?: { width?: number; height?: number };
} {
  const env = resolveEnvironment(projectId, envRef);
  const ctx: ResolveContext = { env: env?.vars ?? {}, secrets: getSecretValues(projectId) };
  const session = env?.login?.session ?? null;
  return {
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(session?.headers ?? {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: session,
    /*
     * 视口跟着被测对象走（U-69）。
     *
     * 探索是最需要它的那一处：视口不够宽时，一整块面板根本不渲染，
     * 而探索**不会报错**——它只是采不到那半个产品，然后照常产出一份看起来正常的材料。
     */
    ...(env?.viewport?.width || env?.viewport?.height ? { viewport: env.viewport } : {}),
  };
}

/**
 * 让 `source.explore` 节点能看一眼跑着的产品。
 *
 * 复用探索那套浏览器会话，但**要的是观察，不是用例**：给模型的提示词在节点那边，
 * 这里只负责把界面上看得见的东西取回来。观察与解读分开，是因为它们会各自变化——
 * 换一套观察方式不该重写提示词，改一句提示词也不该重开浏览器。
 */
/**
 * 子进程要问模型时，由网关执行。
 *
 * 放在网关而不是 runner，有两条硬理由：runner 没有 `ModelClient`，
 * 而且它的 `OPENAI_BASE_URL` 被改写成了 Midscene 的 no-think 代理；
 * 另外这里走 `traced()`，这次调用在 Langfuse 上看得见——
 * 用 Midscene 自己的 `ai*` 问，成本和效果都量不出来。
 */
setChildAsk(async (input) => {
  const req = (input ?? {}) as { prompt?: string; imageDataUrl?: string; schema?: unknown; maxTokens?: number; projectId?: string };
  const r = await projectPlannerModel(req.projectId, "explore.scenario").chat({
    stable: "你是一名资深测试分析师。你要做的是**判断**，不是编造事实：只能引用给你的编号。",
    variable: String(req.prompt ?? ""),
    ...(req.imageDataUrl ? { images: [req.imageDataUrl] } : {}),
    ...(req.schema ? { schema: req.schema as Record<string, unknown> } : {}),
    maxTokens: req.maxTokens ?? 2400,
    label: "explore.scenario",
  });
  return r.text;
});

/*
 * 血缘保留：还没跑完的那些运行，事件一行都不删。
 *
 * 保留窗口按条数算，而一次跑三天的运行会被自己产生的日志挤出窗口——
 * 「这次运行到底发生了什么」于是永远失去答案，界面上看不出任何异常：轨迹只是空的。
 */
setUnfinishedRuns(() => unfinishedRunIds());

setAgentObserver(async (input) => {
  const {
    url, deep, settleMs, maxScreens, dryRounds, stateAbstraction, projectId, envRef,
    scenarioFirst, inPageFirst, groupCap, charter, wallet, explorationScope, workflowRunId, sourceAttempt,
  } = (input ?? {}) as {
    url?: string;
    deep?: boolean;
    settleMs?: number;
    maxScreens?: number;
    workflowRunId?: string;
    sourceAttempt?: ExplorationAttempt;
    explorationScope?: "current-url" | "rules";
    dryRounds?: number;
    stateAbstraction?: string;
    projectId?: string;
    envRef?: string;
    scenarioFirst?: boolean;
    inPageFirst?: "auto" | "on" | "off";
    groupCap?: number;
    /**
     * 带钱包探索：注入一个虚拟 EIP-1193 provider（`exec/injectedWallet.ts`），
     * 地址与链取自本机钱包与 `chainConfig()`——和执行用例那条路用的是同一个账户。
     *
     * 为什么必须是显式参数：未登录与已登录看到的是**两个产品**（docs/v3/history/24 §13）。
     * 不给这个开关，探索永远只看得到未登录那一半，而那一半里下单区全是 N/A。
     */
    wallet?: boolean;
    /** 领域探索 charter；纯数据，过得了 RPC 边界。见 workflowOps.sourceKnowledge。 */
    charter?: import("@testpilot/harness-testing/domain").ExplorationCharter;
  };
  const project = projectId ? getProject(projectId) : undefined;
  // 地址的来源按「越具体越优先」：节点参数 → 运行声明的环境 → 项目的目标端。
  // 中间那一层此前是缺的，所以指定了环境也白指定。
  const env = projectId ? resolveEnvironment(projectId, envRef) : undefined;
  const target = url || env?.baseUrl || project?.targetUrl;
  if (!target) throw new Error("source.explore has no address to open: give it a url, or bind the run to a project");

  if (sourceAttempt) {
    ExplorationAttemptSchema.parse(sourceAttempt);
    if(sourceAttempt.environmentHash!==undefined && sourceAttempt.environmentHash!==explorationEnvironment(projectId!,envRef,!!wallet))throw new Error('exploration_environment_changed_before_dispatch');
    if (sourceAttempt.runId !== workflowRunId || sourceAttempt.projectId !== projectId || sourceAttempt.entryUrl !== target) throw new Error('exploration_attempt_mismatch');
  }
  const live = interactiveSession(`observe-${projectId ?? "adhoc"}`, projectId);
  // 走 observe 而不是 explore：explore 的契约是"返回解析出来的 flows"，把散文喂进它
  // 只会被 `asArray()` 压成 []。观察要的是屏幕上原样的东西，采集是确定性的。
  const untrack = workflowRunId ? trackSourceSession(workflowRunId, () => live.cancel()) : () => {};
  const result = await live.observe(
    {
      url: target,
      sourceAttempt,
      deep,
      settleMs,
      maxScreens, explorationScope,
      dryRounds,
      stateAbstraction,
      /**
       * 探索之前先问一次业务场景。
       *
       * 注入而不是让探索自己去问：探索跑在 runner 进程里，那边没有 ModelClient，
       * 端点还被改写成了 no-think 代理。这里给的是网关自己那一份，
       * 经过 `traced()`，所以这次调用在 Langfuse 上看得见。
       */
      scenarioFirst,
      inPageFirst,
      groupCap,
      ...(charter ? { charter } : {}),
      // ask 不在这里传——**函数过不了 RPC 边界**（探索跑在 runner 进程里）。
      // 它由 runner 侧用 `child.parent.askModel` 组装，见 setChildAsk。
      /**
       * 环境配好的登录步骤，连同解析上下文一起交给探索。
       *
       * 此前探索只能猜「用页面上显示的凭证登录」——那是 SauceDemo 的做法，绝大多数应用
       * 不会把密码印在登录页上。而凭证一直在环境里，执行用例时也一直在用。
       */
      ...(projectId ? observeLogin(projectId, envRef) : {}),
      // 这个环境提供的前提名（人在环境设置里填的）；没填就由探索器按「配了登录就有 session」推。
      ...(env?.capabilities?.length ? { capabilities: env.capabilities } : {}),
      ...(env?.login?.injectedSessionCheck ? {injectedSessionCheck:env.login.injectedSessionCheck} : {}),
      ...(env?.login?.sessionChecks?.length ? { sessionChecks: env.login.sessionChecks } : {}),
      launch: {
        cacheId: `observe-${projectId ?? "adhoc"}`,
        explorationRouteTemplates: String(env?.vars?.TP_EXPLORATION_ROUTE_TEMPLATES ?? '').split(',').map(s=>s.trim()).filter(Boolean),
        ...(projectId ? observeLaunch(projectId, envRef) : {}),
        // 注入钱包与执行用例那条路同源：同一把种子、同一条链，探索因此看得到登录态的产品。
        ...(wallet ? { injected: true, ...resolveChainConfig() } : {}),
      },
    },
    ARTIFACT_DIR,
  ).finally(untrack);
  /**
   * 上限跟着屏数走。这里已经被同一件事咬过两次：
   *
   * 24000 字那一版会在第四五屏上把后面的界面整段切掉；改成 60000 之后，探索从 8 屏
   * 长到 25–30 屏，它又每次都生效了——about 和 contact 两屏被整个切掉，材料里于是
   * 既没有 `Corporate History` 也没有 `CAPTCHA`，看起来像是探索没走到。
   *
   * 现在按屏分配预算在 `budgeted()` 里做（每屏截断并标明截了多少），这一刀只作为
   * 最后的护栏，且放宽到 240000——它再生效就说明 `budgeted` 的预算算错了。
   */
  if (sourceAttempt && !sameExplorationAttempt(result.sourceAttempt, sourceAttempt)) throw new Error('exploration_attempt_mismatch');
  if (result.notes.length > 240000)
    console.warn(`[explore] 材料 ${result.notes.length} 字，超过护栏 240000——按屏分配的预算算错了`);
  /*
   * 护栏这一刀**掐中间**，不从尾巴切。
   *
   * `slice(0, N)` 会把最后几屏整段切掉，而材料是按屏追加的——被切掉的正好是探索
   * 走得最深的那几屏。症状是材料里既没有那几屏的文字，也没有任何痕迹说它们被切过，
   * 看起来就像探索没走到那儿。`trimMiddle` 保留头尾并留下一行标记：
   * 一次被截断的材料，从此说得出自己是被截断的。
   */
  return {
    sourceAttempt: result.sourceAttempt,
    assessment: result.assessment,
    notes: trimMiddle(result.notes, Math.floor(240000 / 4)),
    url: result.url,
    screens: result.screens,
    stoppedBecause: result.stoppedBecause,
    stopped: result.stopped,
    graph: result.graph,
    ...(result.report ? { report: result.report } : {}),
  };
});

/*
 * 「探索直接产用例」这条路已经下掉（2026-08-21）。
 *
 * 它和现在的形状语义冲突：那条路把观察直接变成用例，中间没有一处可以让人说「这条不该这么写」。
 * 现在观察是**材料**——和用户文档一样，先经 `spec.compose` 整理成那份唯一的标准规格，
 * 再由它推出故事与用例。观察本身仍然做，入口是 `source.explore` 节点，
 * 需要浏览器的那一跳走上面的 `observeProduct`。
 *
 * 一并下掉的是 POST /api/projects/:id/explore、GET …/explore/stream、POST /api/explore。
 */

/* ---- environments (per-project target + vars + headers/query + login/session) ---- */
// The captured session blob (live auth cookies + localStorage) NEVER leaves the server.
// The UI only sees whether one exists + when it was captured + its size.
function sanitizeEnv(env: Environment) {
  const s = env.login?.session ?? null;
  return {
    ...env,
    login: {
      sessionChecks: env.login?.sessionChecks ?? [],
      injectedSessionCheck: env.login?.injectedSessionCheck,
      authRequired: env.login?.authRequired ?? false,
      steps: env.login?.steps ?? [],
      apiLogin: env.login?.apiLogin ?? null, // config only (contains placeholders, not secrets)
      capturedAt: env.login?.capturedAt,
      hasSession: !!s,
      sessionCookies: s?.cookies?.length ?? 0,
      sessionOrigins: s?.origins?.length ?? 0,
      sessionHeaders: Object.keys(s?.headers ?? {}).length,
    },
  };
}

// Parse Set-Cookie response headers into Puppeteer-shaped cookie objects.
function parseSetCookies(setCookies: string[], reqUrl: string): Array<Record<string, unknown>> {
  const host = (() => {
    try {
      return new URL(reqUrl).hostname;
    } catch {
      return "";
    }
  })();
  const out: Array<Record<string, unknown>> = [];
  for (const sc of setCookies) {
    const [nv, ...attrs] = sc.split(";").map((p) => p.trim());
    const eq = nv.indexOf("=");
    if (eq < 0) continue;
    const cookie: Record<string, unknown> = {
      name: nv.slice(0, eq),
      value: nv.slice(eq + 1),
      path: "/",
      domain: host,
    };
    for (const a of attrs) {
      const [k, v] = a.split("=");
      const lk = k.toLowerCase();
      if (lk === "domain" && v) cookie.domain = v.replace(/^\./, "");
      else if (lk === "path" && v) cookie.path = v;
      else if (lk === "httponly") cookie.httpOnly = true;
      else if (lk === "secure") cookie.secure = true;
      else if (lk === "samesite" && v)
        cookie.sameSite = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); // Lax/Strict/None
    }
    out.push(cookie);
  }
  return out;
}
// Read a dot-path (e.g. "data.token") out of a parsed JSON value.
function getJsonPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

app.get("/api/projects/:id/environments", (req, res) => {
  res.json({ environments: listEnvironments(req.params.id).map(sanitizeEnv) });
});
app.post("/api/projects/:id/environments", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!body.name) return res.status(400).json({ error: "name is required" });
  // 只把**这次真的说了**的字段交下去；没说的由 upsertEnvironment 沿用已存的（见 environmentInput.ts）。
  const environment = upsertEnvironment({
    projectId: req.params.id,
    id: body.id as string | undefined,
    name: String(body.name),
    ...environmentPatch(body),
  });
  res.json({ environment: sanitizeEnv(environment) });
});
app.delete("/api/environments/:id", (req, res) => {
  deleteEnvironment(req.params.id);
  res.json({ ok: true });
});

// Capture login state: run the env's login flow once, then read cookies + localStorage
// into a reusable storageState. Subsequent runs inject it and SKIP the login steps.
app.post("/api/environments/:id/capture-session", async (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const steps = env.login?.steps ?? [];
  if (!steps.length)
    return res.status(400).json({ error: "this environment has no login steps to run" });
  const ctx: ResolveContext = { env: env.vars, secrets: getSecretValues(env.projectId) };
  const url = resolveText(env.baseUrl || getProject(env.projectId)?.targetUrl || "", ctx);
  if (!url) return res.status(400).json({ error: "no baseUrl set for this environment" });

  try {
    // The browser work happens on a runner; the captured state is stored here, because
    // storing it is database work and the runner holds no state.
    const { storageState, log } = await diagnoseOnRunner<{
      storageState: StorageState;
      log: string[];
    }>("captureSession", {
      url,
      steps,
      resolve: ctx,
      extraHeaders: resolveMap(env.headers, ctx),
      query: resolveMap(env.query, ctx),
    });
    const saved = upsertEnvironment({
      ...env,
      login: {
        ...env.login,
        authRequired: true,
        session: storageState,
        capturedAt: new Date().toISOString(),
      },
    });
    res.json({
      ok: true,
      cookies: storageState.cookies.length,
      localStorage: storageState.origins[0]?.localStorage.length ?? 0,
      log,
      environment: sanitizeEnv(saved),
    });
  } catch (e) {
    res.status(502).json({ error: `capture failed: ${(e as Error).message}` });
  }
});

// API-style login (method C): call the login endpoint directly, capture the session
// cookie and/or a token (→ auth header) from the response — no UI driving. Stored as the
// same session that runs inject + skip login. Credentials come from ${env}/${secret}.
app.post("/api/environments/:id/api-login", async (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const cfg = env.login?.apiLogin;
  if (!cfg?.url) return res.status(400).json({ error: "no API-login endpoint configured" });
  const ctx: ResolveContext = { env: env.vars, secrets: getSecretValues(env.projectId) };
  const secretVals = Object.values(ctx.secrets);
  try {
    const url = resolveText(cfg.url, ctx);
    const method = (cfg.method || "POST").toUpperCase();
    const headers: Record<string, string> = {
      "content-type": cfg.contentType || "application/json",
      ...resolveMap(cfg.headers ?? {}, ctx),
    };
    const body = method === "GET" || !cfg.body ? undefined : resolveText(cfg.body, ctx);
    const resp = await fetch(url, { method, headers, body });

    const setCookies =
      typeof (resp.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (resp.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    const cookies = parseSetCookies(setCookies, url);

    const capturedHeaders: Record<string, string> = {};
    let tokenFound = false;
    if (cfg.tokenPath) {
      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        json = undefined;
      }
      const token = json !== undefined ? getJsonPath(json, cfg.tokenPath) : undefined;
      if (typeof token === "string" && token) {
        capturedHeaders[cfg.tokenHeader || "Authorization"] = (cfg.tokenPrefix ?? "Bearer ") + token;
        tokenFound = true;
      }
    }

    if (!resp.ok)
      return res.status(502).json({ error: `login endpoint returned HTTP ${resp.status}` });
    if (!cookies.length && !tokenFound)
      return res
        .status(502)
        .json({ error: "no session cookie and no token found in the login response" });

    const session: StorageState = {
      cookies,
      origins: [],
      headers: Object.keys(capturedHeaders).length ? capturedHeaders : undefined,
    };
    const capturedAt = new Date().toISOString();
    const saved = upsertEnvironment({
      ...env,
      login: { ...env.login, authRequired: true, session, capturedAt },
    });
    res.json({
      ok: true,
      status: resp.status,
      cookies: cookies.length,
      token: tokenFound,
      environment: sanitizeEnv(saved),
    });
  } catch (e) {
    res.status(502).json({ error: `API login failed: ${redact((e as Error).message, secretVals)}` });
  }
});

// Normalize a pasted cookie array into Puppeteer-shaped cookies (fill domain/path/sameSite).
function normalizeCookies(list: unknown[], host: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const o = { ...(c as Record<string, unknown>) };
    if (typeof o.name !== "string" || o.value === undefined) continue;
    if (!o.domain && host) o.domain = host;
    if (!o.path) o.path = "/";
    if (typeof o.sameSite === "string")
      o.sameSite = o.sameSite.charAt(0).toUpperCase() + o.sameSite.slice(1).toLowerCase();
    out.push(o);
  }
  return out;
}
// Parse a pasted session: a Playwright storageState JSON ({cookies,origins}), a raw cookie
// array, or a `name=value; name2=value2` Cookie header string (domain from the env host).
function parsePastedSession(raw: string, host: string): StorageState | null {
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return { cookies: normalizeCookies(j, host), origins: [] };
    if (j && typeof j === "object" && (Array.isArray(j.cookies) || Array.isArray(j.origins))) {
      return {
        cookies: normalizeCookies(Array.isArray(j.cookies) ? j.cookies : [], host),
        origins: Array.isArray(j.origins) ? j.origins : [],
        headers: j.headers && typeof j.headers === "object" ? j.headers : undefined,
      };
    }
  } catch {
    /* not JSON — fall through to cookie-header parsing */
  }
  const cookies = raw
    .replace(/^cookie:\s*/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, path: "/" };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  return cookies.length ? { cookies, origins: [] } : null;
}

// Paste a session directly (method B): a cookie string or a storageState JSON → stored as
// the session that runs inject + skip login. No login run needed.
app.post("/api/environments/:id/set-session", (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const raw = typeof req.body?.raw === "string" ? req.body.raw.trim() : "";
  if (!raw) return res.status(400).json({ error: "paste a cookie string or a storageState JSON" });
  const ctx: ResolveContext = { env: env.vars, secrets: getSecretValues(env.projectId) };
  const host = (() => {
    try {
      return new URL(
        resolveText(env.baseUrl || getProject(env.projectId)?.targetUrl || "", ctx),
      ).hostname;
    } catch {
      return "";
    }
  })();
  const session = parsePastedSession(raw, host);
  if (!session || (!session.cookies.length && !session.origins.length))
    return res.status(400).json({ error: "could not parse any cookies or storageState" });
  const saved = upsertEnvironment({
    ...env,
    login: { ...env.login, authRequired: true, session, capturedAt: new Date().toISOString() },
  });
  res.json({
    ok: true,
    cookies: session.cookies.length,
    origins: session.origins.length,
    environment: sanitizeEnv(saved),
  });
});

// Clear a captured session (revert to running the UI login flow each run).
app.delete("/api/environments/:id/session", (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const saved = upsertEnvironment({
    ...env,
    login: { ...env.login, session: null, capturedAt: undefined },
  });
  res.json({ ok: true, environment: sanitizeEnv(saved) });
});

/* ---- secrets vault (metadata in/out; plaintext only ever set, never read back) ---- */
app.get("/api/projects/:id/secrets", (req, res) => {
  res.json({ secrets: listSecretMeta(req.params.id) });
});
app.post("/api/projects/:id/secrets", (req, res) => {
  const { key, value } = req.body ?? {};
  if (!key || typeof value !== "string")
    return res.status(400).json({ error: "key and value are required" });
  const secret = setSecret(req.params.id, key, value);
  res.json({ secret }); // returns metadata only — never the value
});
app.delete("/api/projects/:id/secrets/:key", (req, res) => {
  deleteSecret(req.params.id, req.params.key);
  res.json({ ok: true });
});

/* ---- scale: suite runs through the concurrency queue + CI gate ---- */
// Run a suite (filter: "P0" | "P1" | "P2" | "all") via the bounded queue, self-healing
// each case. Quarantined cases run but are excluded from the pass/fail gate (CI门禁).
/**
 * 被要求停下的批次。
 *
 * 进行中的那一条**中断不了**（用例执行没有取消点，这一点服务端别处的注释早写着），
 * 但队列里还没开始的可以一条都不发。二十条用例按错了参数，此前人没有任何办法
 * 让它在二十分钟内停下——现在能停在第 n 条上，而且界面会说清「已停 · 跑了 n/20」。
 */
const cancelledBatches = new Set<string>();

app.post("/api/batches/:id/cancel", (req, res) => {
  cancelledBatches.add(req.params.id);
  res.json({ ok: true, note: "队列里没开始的不再发出；当前这一条跑完就停" });
});

app.post("/api/projects/:id/suite", async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const filter = String(req.body?.filter || "P0");
  const retries = Math.max(0, Number(req.body?.retries ?? 1));
  const all = listCases(project.id);
  const cases = filter === "all" ? all : all.filter((c) => c.priority === filter);
  if (!cases.length) return res.status(400).json({ error: `no ${filter} cases to run` });

  const batch = createBatch(project.id, `${filter} suite · ${cases.length} cases`);
  updateBatch(batch.id, { total: cases.length });

  // Fan out: each case flows through the queue (bounded concurrency) and self-heals.
  await Promise.all(
    cases.map((c) =>
      enqueue(async () => {
        // 停下的判断放在**取活的那一刻**，不是入队时——入队时还没人按停止。
        if (cancelledBatches.has(batch.id)) return;
        try {
          const { run, attempts, healed } = await runCaseDataDriven(c, { ...(req.body ?? {}), __sessionKey: batch.id }, retries);
          const quarantined = !!getCase(c.id)?.quarantined;
          const outcome = run.infraError ? "error" : run.status === "passed" ? "passed" : "failed";
          addBatchRun({
            batchId: batch.id,
            caseId: c.id,
            caseTitle: c.title,
            runId: run.id,
            status: quarantined && outcome !== "error" ? "quarantined" : outcome,
            attempts,
            healed,
          });
        } catch {
          addBatchRun({
            batchId: batch.id,
            caseId: c.id,
            caseTitle: c.title,
            status: getCase(c.id)?.quarantined ? "quarantined" : "failed",
            attempts: 1,
            healed: false,
          });
        }
      }, `${filter}:${c.title.slice(0, 28)}`),
    ),
  );

  // 批次跑完（或被停）：关掉复用的浏览器。放在聚合之前——账要在浏览器关掉之后才算齐。
  await releaseSessionOnRunners(batch.id);

  // Aggregate + CI gate. A real failure fails the gate; an infra/model error means
  // "no verdict" so it also blocks a green gate (can't confirm pass) but is reported
  // distinctly and excluded from flake stats. Quarantined cases never affect the gate.
  const items = getBatchRuns(batch.id);
  const passed = items.filter((i) => i.status === "passed").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const errored = items.filter((i) => i.status === "error").length;
  const quarantined = items.filter((i) => i.status === "quarantined").length;
  const healed = items.filter((i) => i.healed).length;
  const flaky = cases.filter((c) => getFlakiness(c.id)?.verdict === "flaky").length;
  const stopped = cancelledBatches.delete(batch.id);
  /**
   * 被停下的批次**不能给绿灯**——没跑完的用例不是「没问题」，是「不知道」。
   * total 也保留原计划的条数：把它改写成实跑条数，一个停在第 8 条的批次
   * 会显示成「8/8 全过」，那是在撒谎。
   */
  const gate: Batch["gate"] = stopped || failed > 0 || errored > 0 ? "fail" : "pass";
  updateBatch(batch.id, {
    status: "done",
    total: stopped ? cases.length : items.length,
    passed,
    failed,
    healed,
    flaky,
    quarantined,
    errored,
    gate,
    finishedAt: new Date().toISOString(),
  });
  res.json({ batch: getBatch(batch.id), items, gate, stopped });
});

app.get("/api/queue", (_req, res) => res.json({ ...queueStatus(), model: modelGate.stats() }));
app.get("/api/projects/:id/batches", (req, res) =>
  res.json({ batches: listBatches(req.params.id) }),
);
app.get("/api/batches/:id", (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: "batch not found" });
  res.json({ batch, items: getBatchRuns(batch.id) });
});
app.get("/api/projects/:id/flakiness", (req, res) =>
  res.json({ flakiness: listFlakiness(req.params.id) }),
);
/**
 * 隔离一条用例，或解除隔离。
 *
 * 走一个自己的端点而不是 `PATCH /api/cases/:id`，因为它不是一次普通的字段修改：
 * **它会改变门禁的结论**。一条被隔离的用例照跑，但它的红不再拦门禁——
 * 所以理由必填，动作进台账，事后一个绿灯说得清自己是怎么绿的。
 */
app.post("/api/cases/:id/quarantine", (req, res) => {
  const kase = getCase(req.params.id);
  if (!kase) return res.status(404).json({ error: "case not found" });
  const on = !!req.body?.on;
  const reason = String(req.body?.reason ?? "");
  const by = String(req.body?.by ?? "unknown");
  try {
    // 当时门禁是什么判决：隔离影响的就是它。取这个项目最近一次批次的判决。
    const gateAtTime = listBatches(kase.projectId)[0]?.gate;
    const entry = logQuarantine({
      caseId: kase.id,
      projectId: kase.projectId,
      on,
      reason,
      by,
      ...(gateAtTime ? { gateAtTime } : {}),
    });
    const updated = updateCase(kase.id, { quarantined: on });
    res.json({ case: updated, entry });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 基线待办的另外两个出口：**判为回归**、**承认是环境噪声**。
 *
 * 「接受为新基线」此前是唯一一个出口——于是一次真回归和一次改版走同一个按钮，
 * 而按下去之后回归就变成了新的正确答案，这条用例从此绿着。
 * 这两个出口都不动基线：回归让这条用例继续红，噪声只是把这一条从待办里划掉。
 */
app.post("/api/cases/:id/baseline-verdict", (req, res) => {
  const kase = getCase(req.params.id);
  if (!kase) return res.status(404).json({ error: "case not found" });
  const body = (req.body ?? {}) as {
    kind?: "visual" | "perf";
    stepIdx?: number;
    runId?: string;
    verdict?: "regression" | "noise";
    note?: string;
    by?: string;
  };
  if (body.verdict !== "regression" && body.verdict !== "noise")
    return res.status(400).json({ error: "verdict 只能是 regression 或 noise" });
  if (body.kind !== "visual" && body.kind !== "perf")
    return res.status(400).json({ error: "kind 只能是 visual 或 perf" });
  if (!body.runId) return res.status(400).json({ error: "要说清是哪一次运行的差异" });
  // 环境噪声这一档只给性能：一张截图差了 8.5% 不会是"网络当时有点抖"。
  if (body.verdict === "noise" && body.kind !== "perf")
    return res.status(400).json({ error: "「环境噪声」只适用于性能基线——界面的差异不会是噪声" });
  try {
    res.json({
      verdict: recordBaselineVerdict({
        caseId: kase.id,
        projectId: kase.projectId,
        kind: body.kind,
        ...(body.stepIdx !== undefined ? { stepIdx: body.stepIdx } : {}),
        runId: body.runId,
        verdict: body.verdict,
        note: String(body.note ?? ""),
        by: String(body.by ?? "unknown"),
      }),
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** 隔离台账：谁 · 什么时候 · 为什么 · 当时门禁是什么判决。 */
app.get("/api/projects/:id/quarantine-log", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const caseId = typeof req.query.caseId === "string" ? req.query.caseId : undefined;
  res.json({ entries: listQuarantineLog(req.params.id, caseId) });
});

app.post("/api/cases/:id/recompute-flakiness", (req, res) => {
  if (!getCase(req.params.id)) return res.status(404).json({ error: "case not found" });
  res.json({ flakiness: computeFlakiness(req.params.id) });
});

// Trend dashboard: pass rate / flake rate / MTTR / coverage + per-batch/day series.
app.get("/api/projects/:id/trends", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  res.json(computeTrends(req.params.id));
});

/* ---- global settings: LLM-debug toggle + editable prompt templates ---- */
app.get("/api/settings", (_req, res) => {
  res.json({ settings: getSettings(), defaults: DEFAULT_PROMPTS });
});
app.post("/api/settings", (req, res) => {
  const patch: Partial<Awaited<ReturnType<typeof getSettings>>> = {};
  if (typeof req.body?.debugLLM === "boolean") patch.debugLLM = req.body.debugLLM;
  if (typeof req.body?.enforceLang === "boolean") patch.enforceLang = req.body.enforceLang;
  if (req.body?.prompts && typeof req.body.prompts === "object") patch.prompts = req.body.prompts;
  res.json({ settings: updateSettings(patch) });
});
app.post("/api/settings/reset-prompts", (_req, res) => {
  res.json({ settings: resetPrompts() });
});
// Recent LLM-debug captures (metadata) for the UI — actual payloads live as files.
app.get("/api/llm-debug", (_req, res) => {
  try {
    if (!existsSync(LLM_DEBUG_DIR)) return res.json({ on: getSettings().debugLLM, entries: [] });
    const files = readdirSync(LLM_DEBUG_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-50)
      .reverse();
    res.json({ on: getSettings().debugLLM, dir: LLM_DEBUG_DIR, entries: files });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/* ---- lineage (event log) ---- */
// The event table is the lineage; this is its read side. The UI uses it to hydrate the
// log tail on first paint (the WS only carries what happens after you connect), and it
// is the same read that `replay` will use for a workflow run.
/**
 * 事件。**按运行取，或者取最近的**——两者都不再是"先取最旧一万条再切尾"。
 *
 * 原来这里是 `bus.replay(sinceId, 10_000).slice(-limit)`，而 store 的 `since` 是
 * `WHERE id > ? ORDER BY id ASC LIMIT ?`。两者合起来的效果：一旦库里事件超过一万条，
 * 拿到的永远是**最旧一万条里的第 9001–10000 条**。于是历史运行的轨迹永远是空的，
 * 而界面把这个取数缺陷说成了一句关于这次运行的事实陈述——「这次运行还没有留下轨迹」。
 */
app.get("/api/events", (req, res) => {
  const sinceId = Math.max(0, Number(req.query.sinceId) || 0);
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 200));
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const wfRunId = typeof req.query.wfRunId === "string" ? req.query.wfRunId : undefined;
  let events = wfRunId ? eventStore.byRun(wfRunId, sinceId, limit) : eventStore.latest(limit);
  if (kind) events = events.filter((e) => e.kind === kind);
  // 被截断了就说出来。静默截断和取错数据是同一个失败模式：报告看起来完全正常。
  const total = wfRunId ? eventStore.countByRun(wfRunId) : undefined;
  const nextSince = events.length ? events[events.length - 1].id : sinceId;
  res.json({
    head: bus.head(),
    events,
    scoped: !!wfRunId,
    ...(total !== undefined ? { total, truncated: total > sinceId + events.length, nextSince } : {}),
  });
});

/* ---- workflows (the graph runtime) ---- */
// Commands here, facts on the bus: starting a run returns its id immediately, and
// everything that happens after arrives as `wf.*` events over /ws.
app.get("/api/node-types", (_req, res) => res.json({ nodeTypes: registry.list() }));

app.get("/api/graphs", (_req, res) => res.json({ graphs: listGraphs() }));

app.get("/api/graphs/:id", (req, res) => {
  const def = getGraph(req.params.id);
  return def ? res.json({ graph: def }) : res.status(404).json({ error: "unknown graph" });
});

app.post("/api/graphs", (req, res) => {
  try {
    const def = req.body as Parameters<typeof saveGraph>[0];
    const issues = validateGraph(def, registry);
    // A graph is validated before it is stored, not when it runs: the point of the check
    // is to catch a bad connection while it is being drawn.
    if (issues.length) return res.status(400).json({ error: "invalid graph", issues });
    res.json({ graph: saveGraph(def, (req.body as { note?: string }).note) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** The versions of one graph, newest first. */
app.get("/api/graphs/:id/versions", (req, res) => {
  res.json({ versions: graphVersions(req.params.id) });
});

/** One saved version, as it was. */
app.get("/api/graphs/:id/versions/:version", (req, res) => {
  const def = getGraphVersion(req.params.id, Number(req.params.version));
  return def ? res.json({ graph: def }) : res.status(404).json({ error: "no such version" });
});

/** What changed between two versions. */
app.get("/api/graphs/:id/diff", (req, res) => {
  try {
    const diff = diffGraphVersions(req.params.id, Number(req.query.from), Number(req.query.to));
    res.json({ diff, lines: describeDiff(diff) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/wf/runs", async (req, res) => {
  try {
    const body = req.body ?? {};
    /**
     * 目标只在**请求真的说了**的时候才拼出来。
     *
     * 此前这里写的是 `body.target ?? { projectId: body.projectId, ... }`——那个兜底对象
     * **永远为真**，哪怕三个字段全是 undefined。于是 `startRun` 里那句
     * 「Re-running one node of an existing run must use that run's target」被彻底废掉：
     * `input.target ?? previous.target` 永远走第一支，拿到一个空对象。
     *
     * 实测后果（就在这次修它之前）：重跑 `wf-mtd7gcdk` 的一个节点，目标地址被静默擦成
     * `{}`，三条用例在 12 毫秒内以 infra 失败，`record()` 因为没有 projectId 直接返回，
     * 一条执行记录都没写——而运行状态是 `done`。**一次什么都没跑的运行，报告说它成功了。**
     *
     * 一个 run 说不清它跑的是谁，「这些用例过了」就是一句关于虚空的话。
     */
    const stated =
      body.target ??
      (body.projectId || body.envRef || body.url
        ? { projectId: body.projectId, envRef: body.envRef, url: body.url }
        : undefined);
    const input = { ...body, ...(stated ? { target: stated } : {}) };
    // 同一个请求体、同一个返回形状，两条 harness。前端只读 `wfRunId`，
    // 但两条路的返回不一样的话，这个开关就不是一个开关而是两套接口。
    res.json(RUNTIME === "penguin" ? await penguinStartRun(input) : await startRun(input));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/wf/runs", (_req, res) =>
  res.json({ runs: outputStore.listRuns(), active: activeRuns() }));

app.get("/api/wf/runs/:id", async (req, res) => {
  const run = outputStore.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });
  const outputs = await allOutputs(req.params.id).catch(() => ({}));
  // Outputs can be large (a whole batch of cases); the UI asks for one node's when it
  // needs the detail, so the list view stays cheap.
  const summary = Object.fromEntries(
    Object.entries(outputs).map(([nodeId, value]) => [nodeId, summarize(value)]),
  );
  res.json({ run, outputs: summary });
});

app.get("/api/wf/runs/:id/nodes/:nodeId", async (req, res) => {
  const value = await nodeOutput(req.params.id, req.params.nodeId).catch(() => undefined);
  return value === undefined ? res.status(404).json({ error: "no output" }) : res.json({ output: value });
});

app.post("/api/wf/runs/:id/nodes/:nodeId/run", async (req, res) => {
  const run = outputStore.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });
  const mode = req.query.mode === "from" ? "from" : "only";
  const detail = runDetail(req.params.id);
  /**
   * 上游产物不在就不许起跑。
   *
   * 此前这里照跑不误，而 runtime 遇到 `no stored output from …` 会直接 finish("failed")，
   * 网关照写进运行记录——**一次点错的重跑会把一次 done 的运行改写成 failed**，
   * 而两个重跑按钮在任何一个节点上都是亮的。这不是提示语能解决的，得拦在起跑前。
   */
  const missing = await missingUpstream(req.params.id, req.params.nodeId).catch(() => undefined);
  if (missing)
    return res.status(409).json({
      error: `${missing} 还没有产出，${req.params.nodeId} 重跑不了——先跑 ${missing}，或者从它那里往下重跑。`,
      missing,
    });
  try {
    res.json(
      await startRun({
        graphId: String(run.graphId),
        wfRunId: req.params.id,
        mode: { kind: mode, node: req.params.nodeId },
        // 续跑起来的运行，根节点的输入来自它的种子出处；重跑请求体是空的，
        // 此前于是 runtime 拿到 undefined，zod 当场报错。
        seed:
          req.body?.seed ??
          (detail.seedFrom
            ? await nodeOutput(detail.seedFrom.runId, detail.seedFrom.node).catch(() => undefined)
            : undefined),
        // 预算与已花费都要带：resumeRun 早就这么做了，而这条路上没有——
        // 于是一次部分重跑会把预算计数清零，上限悄悄变成"每一段一次"。
        budget: detail.budget,
        spent: detail.spend,
      }),
    );
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Carry on from the breakpoint this run stopped at. */
// 哪几张图能接着这次运行跑，以及起一次这样的运行。阶段一与阶段二是两张图（各自迭代、
// 各自评测），所以「跑完 gate 然后呢」需要有人回答。
app.get("/api/wf/runs/:id/continuations", async (req, res) => {
  try {
    res.json({ continuations: await continuationsFor(req.params.id) });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.post("/api/wf/runs/:id/continue", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { graphId?: string; params?: Record<string, Record<string, unknown>> };
    res.json(await continueRun(req.params.id, String(body.graphId ?? ""), body.params));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 改这次运行的上限，或者撤掉它（`{"budget": null}`）。
 *
 * 撞了上限的运行只接受这一件事。让「继续」顺手把上限提上去，等于让上限在最容易被忽略
 * 的时刻失效——而那正是它该起作用的时刻。
 */
app.patch("/api/wf/runs/:id/budget", (req, res) => {
  try {
    const body = req.body as { budget?: { calls?: number; usd?: number; ms?: number } | null };
    const detail = setRunBudget(req.params.id, body?.budget ?? null);
    res.json({ ok: true, budget: detail.budget ?? null, spend: detail.spend ?? null });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 断点属于这次运行。前端点亮一个红点，就要落到这里——
 * 否则那个红点只是浏览器里的一个装饰，而「这次会不会停」由运行记录里的另一份说了算。
 */
app.patch("/api/wf/runs/:id/breakpoints", (req, res) => {
  try {
    const list = Array.isArray(req.body?.breakpoints) ? req.body.breakpoints.map(String) : [];
    const detail = setRunBreakpoints(req.params.id, list);
    res.json({ ok: true, breakpoints: detail.breakpoints ?? [] });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.post("/api/wf/runs/:id/resume", async (req, res) => {
  try {
    res.json(await resumeRun(req.params.id));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/wf/runs/:id/cancel", async (req, res) => {
  // Penguin 起的那些由 penguinRun 收：那边没有 agent 子进程可以 RPC，
  // 停的是看门狗，session 留给 Penguin 自己收（红线之外的一条老规矩：不杀别人起的进程）。
  if ((runDetail(req.params.id) as { runtime?: string }).runtime === "penguin") {
    const p = penguinCancelRun(req.params.id);
    if (p.result === "unknown-run") return res.status(404).json({ error: "unknown run" });
    return res.json(p);
  }
  const r = await cancelRun(req.params.id);
  if (r.result === "unknown-run") return res.status(404).json({ error: "unknown run" });
  res.json(r);
});

/** 这次运行能不能接上、已经跑完了哪几步。界面用它把"接上"这个按钮点亮。 */
app.get("/api/wf/runs/:id/resume-point", async (req, res) => {
  const point = await resumePoint(req.params.id).catch(() => undefined);
  res.json({ point: point ?? null });
});

/** Big node outputs are summarized for the list view; the detail endpoint returns them whole. */
function summarize(value: unknown): unknown {
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) out[k] = { kind: "array", length: v.length };
      else if (v && typeof v === "object") out[k] = { kind: "object", keys: Object.keys(v).slice(0, 12) };
      else if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      else out[k] = v;
    }
    return out;
  }
  return value;
}

/* ---- review queue ---- */
// Generated cases wait here. Approving is what puts one on the board — see review.ts for
// why the board is not filled automatically.
// The code line, and what has been rewritten in it. Both read straight out of the run that
// produced the code, so neither can report a score that run never got.
app.get("/api/projects/:id/code-line", async (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try {
    res.json(await codeLine(req.params.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/projects/:id/changes", async (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try {
    res.json({ changes: await changes(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// The baselines still waiting for a person. The approval buttons live on the run detail;
// this is the list that says which runs to open.
app.get("/api/projects/:id/pending-baselines", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  /*
   * 预算跟着待审批一起发出去。
   *
   * 判一次性能回归的人要同时看到三个数：现在多少、基线多少、**预算是多少**。
   * 少了第三个，「TTFB 从 620 涨到 780」说不出该按「确认回归」还是「只是抖动」——
   * 780 还在 800 的预算里，那多半是抖动；如果预算是 700，那就是真回归。
   */
  res.json({ ...pendingBaselines(req.params.id), perfBudget: config.perfBudget });
});

app.get("/api/projects/:id/traceability", async (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try {
    res.json(await traceability(req.params.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 一次运行刚生成、还没批准的那一批的追溯。
 *
 * 复核这一批的时候恰恰需要它：要看追溯得先批准，批准又需要先复核——那个顺序是反的。
 */
app.get("/api/wf/runs/:id/traceability", async (req, res) => {
  try {
    res.json(await traceabilityOfRun(req.params.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 跑一次变异测试。
 *
 * 在这个接口之前，变异那条路径是**只读的**：模块齐全、报告能读、缺口能标在图上，
 * 但 `saveMutationReport` 全仓库零调用——盘上那两份报告的生产者已经不在代码里了。
 * 也就是说这个产品最强的一处能力不可重跑，那个 0.600 是一次性的、没人能验证的数字。
 *
 * 后台跑：一轮是「变异体数 × 跑一遍用例集」，几十分钟起步。进度走 `mutation.*` 事件。
 */
app.post("/api/mutation/:wfRunId", (req, res) => {
  const body = (req.body ?? {}) as { node?: string; limit?: number; cases?: number; codeFrom?: string };
  const started = runMutation({ wfRunId: req.params.wfRunId, ...body });
  started.catch((e) => console.warn(`[testpilot] mutation ${req.params.wfRunId} failed:`, (e as Error).message));
  res.json({
    ok: true,
    wfRunId: req.params.wfRunId,
    note: "running; 一轮是「变异体数 × 跑一遍用例集」，看 mutation.* 事件或轮询 GET",
  });
});

/** 这次运行最近一份变异报告。没有就说没有——空报告和 0 分是两回事。 */
app.get("/api/mutation/:wfRunId", (req, res) => {
  const r = readMutationReport(req.params.wfRunId);
  return r ? res.json({ report: r }) : res.status(404).json({ error: "这次运行还没有变异报告" });
});

/* ---- 测试数据集 ---- */

app.get("/api/projects/:id/datasets", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const sets = listDatasets(req.params.id);
  // 「谁在用它」要跟着列表走：一个不知道被谁用着的数据集，没人敢删。
  const cases = listCases(req.params.id);
  res.json({
    datasets: sets.map((d) => ({
      ...d,
      usedBy: cases.filter((c) => c.dataKey === d.name).map((c) => ({ id: c.id, title: c.title })),
    })),
  });
});

/**
 * 解析但**不落库**——导入的第一步是让人看一眼解析成了什么。
 *
 * 一份列名解析错的数据集，症状不是报错，是二十分钟后一批「断言没通过」，
 * 而错的是数据不是产品。所以预览是必经的一步，不是可选的便利。
 */
app.post("/api/datasets/preview", (req, res) => {
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text?.trim()) return res.status(400).json({ error: "没有内容可解析" });
  try {
    const { rows, format } = parseRows(text);
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    res.json({ format, columns, rows: rows.slice(0, 50), total: rows.length, warnings: inspectRows(rows) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/projects/:id/datasets", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const { name, text, rows, uniqueCols, keepCols } = (req.body ?? {}) as {
    name?: string;
    text?: string;
    rows?: Array<Record<string, string>>;
    uniqueCols?: string[];
    /** 只落这几列。不给就是全落——旧调用方的行为一个字不变。 */
    keepCols?: string[];
  };
  if (!name?.trim()) return res.status(400).json({ error: "数据集要有名字——用例靠名字引它" });
  try {
    const all = rows ?? parseRows(String(text ?? "")).rows;
    /*
     * 没勾的列**不进库**。
     *
     * 关键的是那几个看起来像凭证的列：数据集会跟着导出的工程进版本库，
     * 一列 `password` 落进去就是一次凭证泄漏，而它在界面上看起来只是一列普通数据。
     * 前端把它们默认取消勾选并且要人明确解锁；这里做的是同一件事的另一半——
     * 不勾就是真的不存，而不是存下来再在界面上藏起来。
     */
    const parsed =
      keepCols?.length
        ? all.map((r) => Object.fromEntries(keepCols.filter((c) => c in r).map((c) => [c, r[c]])))
        : all;
    if (!parsed.length) return res.status(400).json({ error: "一行数据都没有" });
    if (keepCols?.length && !Object.keys(parsed[0] ?? {}).length)
      return res.status(400).json({ error: "一列都没勾——那存下来的会是一批空行" });
    res.json({
      dataset: saveDataset({ projectId: req.params.id, name: name.trim(), rows: parsed, uniqueCols }),
      warnings: inspectRows(parsed),
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.delete("/api/datasets/:id", (req, res) => {
  deleteDataset(req.params.id);
  res.json({ ok: true });
});

/**
 * 这条用例引的列，绑的数据集有没有。
 *
 * `${row.emial}` 现在会**原样留在步骤里**——那串字会被当成字面量输进表单，
 * 而没有任何一层会喊一声。这个接口就是那一声。
 */
app.get("/api/cases/:id/data-binding", (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const ds = c.dataKey ? getDataset(c.projectId, c.dataKey) : undefined;
  const steps = [...c.steps.map((s) => s.text), c.precondition ?? "", c.expected ?? ""];
  res.json({ dataKey: c.dataKey ?? "", dataset: ds ? { name: ds.name, columns: ds.columns, rows: ds.rows.length, uniqueCols: ds.uniqueCols } : undefined, ...checkBinding(steps, ds) });
});

app.get("/api/cases/:id/code", async (req, res) => {
  try {
    res.json({ provenance: await codeProvenance(req.params.id) });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

/**
 * 把用例的代码换成给定的那一段。
 *
 * 「退回到第 N 轮」用它：写回的是修复循环当时存下来的代码，不是重新生成的一段。
 * 重生成会得到另一段代码，那就不叫退回了。
 */
app.patch("/api/cases/:id/code", (req, res) => {
  const code = req.body?.code;
  if (typeof code !== "string") return res.status(400).json({ error: "code must be a string" });
  const c = updateCase(req.params.id, { code });
  if (!c) return res.status(404).json({ error: "case not found" });
  res.json({ case: c });
});

app.get("/api/review", async (_req, res) => {
  try {
    res.json({ runs: await pendingRuns() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/review/:wfRunId", async (req, res) => {
  try {
    res.json({ batch: await reviewBatch(req.params.wfRunId) });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.post("/api/review/:wfRunId/approve", async (req, res) => {
  try {
    const created = await approve({ wfRunId: req.params.wfRunId, ...(req.body ?? {}) });
    mirrorDecisions(req.params.wfRunId, (req.body?.caseIds ?? []) as string[], "approved");
    res.json({ created, count: created.length });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** One case, replaced by what the reviewer wrote. The product itself is left alone. */
app.patch("/api/review/:wfRunId/cases/:caseId", async (req, res) => {
  try {
    res.json({ batch: await editCase(req.params.wfRunId, req.params.caseId, req.body ?? {}) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** One change applied across a selection: find-and-replace, priority, precondition, revert. */
app.post("/api/review/:wfRunId/batch", async (req, res) => {
  try {
    const { caseIds, op } = (req.body ?? {}) as { caseIds?: string[]; op?: Parameters<typeof batchAdjust>[2] };
    if (!Array.isArray(caseIds) || !caseIds.length) return res.status(400).json({ error: "caseIds is required" });
    if (!op?.kind) return res.status(400).json({ error: "op is required" });
    res.json(await batchAdjust(req.params.wfRunId, caseIds, op));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Ask the model to write the selected cases again, answering the objections against them.
 * A model call per case, so it is a selection, not a batch-wide button.
 */
app.post("/api/review/:wfRunId/regenerate", async (req, res) => {
  try {
    const { caseIds, lang, note } = (req.body ?? {}) as { caseIds?: string[]; lang?: string; note?: string };
    if (!Array.isArray(caseIds) || !caseIds.length) return res.status(400).json({ error: "caseIds is required" });
    res.json(await regenerate(req.params.wfRunId, caseIds, { lang, note }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * 把一条缺口补成一条用例。
 *
 * 缺口分析此前**停在显示上**：算得出、画得出、然后没有下一步。这条路由是那个下一步——
 * 补出来的用例过一遍门禁①，进复核队列，等的是和别的候选同一个决定。
 *
 * `blind`（连看都没看见）那一类会被拒：一条对着没人见过的界面写出来的用例，
 * 它的绿色说明不了任何事，而它会**看起来**像覆盖率涨了一格。
 */
app.post("/api/review/:wfRunId/gap-case", async (req, res) => {
  try {
    const { gap, lang } = (req.body ?? {}) as { gap?: Parameters<typeof caseFromGap>[1]; lang?: string };
    if (!gap?.what) return res.status(400).json({ error: "要给出是哪条缺口" });
    res.json(await caseFromGap(req.params.wfRunId, gap, { ...(lang ? { lang } : {}) }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/review/:wfRunId/reject", (req, res) => {
  try {
    const n = reject({ wfRunId: req.params.wfRunId, ...(req.body ?? {}) });
    mirrorDecisions(req.params.wfRunId, (req.body?.caseIds ?? []) as string[], "rejected", req.body?.note);
    res.json({ rejected: n });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/* ---- 审计台（docs/v3/01 §1–§3；形状由 src/lib/audit.ts 定死） ---- */

/**
 * 决定同时落一份到 `runs/<runId>/decisions.json`。
 *
 * 契约 §1：下一个 session 的 `read_decisions` 读的是**那个文件**，不是这个库。
 * 只写库，「已批准的用例进 g2」这条链就断在这里；只写文件，看板与队列立刻失忆。
 * 所以两处都写，方向是库 → 文件（库那份仍是复核的真相，文件那份是给下一次运行的输入）。
 *
 * 写失败不拦请求：一次批准已经生效了，把它回滚成 400 只会让人以为没批准。
 */
function mirrorDecisions(
  wfRunId: string,
  caseIds: string[],
  decision: Decision["decision"],
  reason?: string,
): void {
  if (!caseIds?.length) return;
  if ((runDetail(wfRunId) as { runtime?: string }).runtime !== "penguin") return;
  try {
    const at = new Date().toISOString();
    writeDecisions(
      penguinWorkspaceOf(wfRunId),
      wfRunId,
      caseIds.map((caseId) => ({
        caseId,
        decision,
        by: "review",
        at,
        ...(reason ? { reason: String(reason) } : {}),
      })),
    );
  } catch (e) {
    log(`decisions.json 没写成（${wfRunId}）：${(e as Error).message}`);
  }
}

/** 404 与 5xx 分开：`src/lib/audit.ts` 的 `get()` 只吞 404，5xx 照抛。 */
function auditFail(res: express.Response, e: unknown): void {
  if (e instanceof NotFound) {
    res.status(404).json({ error: e.message });
    return;
  }
  res.status(500).json({ error: (e as Error).message });
}

/** `GET /api/audit/:runId/calibration` → `{ sample, labels, kappa? }` */
app.get("/api/audit/:runId/calibration", async (req, res) => {
  try {
    res.json(await calibration(req.params.runId));
  } catch (e) {
    auditFail(res, e);
  }
});

/** `GET /api/audit/:runId/scan` → `ScanReport` */
app.get("/api/audit/:runId/scan", (req, res) => {
  try {
    res.json(auditScan(req.params.runId));
  } catch (e) {
    auditFail(res, e);
  }
});

/** `GET /api/audit/:runId/holds` → `{ total, byGate, holds }`：这次运行被门禁拦了几次、被哪道门拦的。 */
app.get("/api/audit/:runId/holds", (req, res) => {
  try {
    res.json(holdsOf(req.params.runId));
  } catch (e) {
    auditFail(res, e);
  }
});

/** `GET /api/audit/:runId/diff` → `{ added, removed, changed }` */
app.get("/api/audit/:runId/diff", async (req, res) => {
  try {
    res.json(await auditDiff(req.params.runId));
  } catch (e) {
    auditFail(res, e);
  }
});

/**
 * `POST /api/audit/:runId/labels`，body 是 `HumanLabel[]`。
 *
 * 400 而不是 404：body 不是数组是**调用方错了**，前端不该把它当成「端点还没建」
 * 而静默退回假数据——那会让一次标注凭空消失。
 */
app.post("/api/audit/:runId/labels", (req, res) => {
  try {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: "body 要是一个 HumanLabel[]" });
    res.json(appendLabels(req.params.runId, req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/* ---- evaluation ---- */
// Paired evaluation is a long job (two full runs), so the request starts it and returns
// the id; progress arrives as events and the result is stored.
app.post("/api/evals/paired", (req, res) => {
  try {
    const request = req.body as Parameters<typeof runPairedEval>[0];
    if (!request?.graphId || !request.a || !request.b)
      return res.status(400).json({ error: "graphId, a and b are required" });
    res.status(202).json({ ok: true, ...startPairedEval(request) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/evals/registered", async (req,res) => {
 try { res.status(201).json(await evaluateRegisteredRuns(req.body)); }
 catch(e) { res.status(400).json({error:(e as Error).message}); }
});
app.get("/api/evals", (_req, res) => res.json({ evals: listEvals() }));
app.get('/api/evidence-studies', (_req,res) => res.json({studies:listStudies()}));
app.post('/api/evidence-studies', (_req,res) => {
  try {res.status(202).json(startStudy());} catch(e) {res.status(409).json({error:(e as Error).message});}
});
app.get('/api/evidence-studies/:id', (req,res) => {
  try {res.json(readStudy(req.params.id));} catch(e) {res.status(404).json({error:(e as Error).message});}
});
app.get('/api/evidence-studies/:id/files/:file', (req,res) => {
  try {
    const file=evidenceFile(req.params.id,req.params.file);
    if(req.headers['x-testpilot-actor']==='agent'&&file.endsWith('.png'))return res.json({kind:'screenshot',path:req.path});
    res.sendFile(file);
  } catch(e) {res.status(404).json({error:(e as Error).message});}
});
app.post('/api/evidence-studies/:id/review', (req,res) => {
  try {reviewerPrincipal(req);res.json(reviewStudy(req.params.id,req.body));} catch(e) {res.status(409).json({error:(e as Error).message});}
});

/* ─────────────── 07 P5：成本 / 记分板 / gold ─────────────── */

/** 成本账（T-21）：和 `scripts/cost-report.mjs --json` 同一份聚合。 */
app.get("/api/projects/:id/cost", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const last = Math.max(1, Math.min(200, Number(req.query.last ?? 10) || 10));
  res.json(projectCost(req.params.id, last));
});

/** 记分板（T-18）：只读 `benchmark/*\/scoreboard.yaml`（JSON 兼容的 YAML，`score_run` 这么写）。不提供编辑——记分板由工具追加。 */
app.get("/api/scoreboard", (req, res) => {
  const want = typeof req.query.capability === "string" ? req.query.capability : undefined;
  const root = resolve(REPO_ROOT, "benchmark");
  const catalog = benchmarkCatalog(root);
  const caps = catalog.filter(c => (req.query.includeArchived === "1" || !c.archived) && (!want || c.capability === want)).map(c => c.capability);
  const entries: Array<Record<string, unknown>> = [];
  for (const cap of caps) {
    const p = resolve(root, cap, "scoreboard.yaml");
    if (!existsSync(p)) continue;
    try {
      for (const e of storedScoreboard(p)) entries.push({ capability: cap, ...e, projectId: catalog.find(c => c.capability === cap)?.projectId, archived: !!catalog.find(c => c.capability === cap)?.archived });
    } catch (e) {
      entries.push({ capability: cap, error: `scoreboard.yaml 读不出：${(e as Error).message}` });
    }
  }
  res.json({ capabilities: caps, entries, catalog, diagnostics: listEvals(), penguinUrl: process.env.TP_PENGUIN_EVALUATION_URL || "http://127.0.0.1:7365", activeVersion: readActiveEvolution() });
});

/**
 * 两行做 paired（T-18 验收 ②）：跨 goldHash 的两行**服务端拒**——界面禁用只是礼貌，拒绝才是规则。
 * 真正的比较由 MCP 的 `paired_eval` 做（它读两次运行的目录与 gold）；这里只把门守住并转交。
 */
app.post("/api/scoreboard/paired", async (req, res) => {
  const { a, b, goldPath, runsDir } = (req.body ?? {}) as { a?: Record<string, unknown>; b?: Record<string, unknown>; goldPath?: string; runsDir?: string };
  if (!a || !b) return res.status(400).json({ error: "a 与 b 两条记分板条目都要给" });
  const ga = String(a.goldHash ?? (a.binding as Record<string, unknown> | undefined)?.goldHash ?? "");
  const gb = String(b.goldHash ?? (b.binding as Record<string, unknown> | undefined)?.goldHash ?? "");
  if (!ga || !gb || ga !== gb)
    return res.status(409).json({ error: `跨谱系不可比：goldHash ${ga || "?"} vs ${gb || "?"}。同一份 gold 上的两条才能做 paired。`, code: "LINEAGE" });
  const runA = String(a.runId ?? ""), runB = String(b.runId ?? "");
  if (!runA || !runB || !goldPath) return res.status(400).json({ error: "两条条目都要带 runId，且要给 goldPath" });
  try {
    const entry = await pairedEval({ a: runA, b: runB, goldPath, ...(runsDir ? { runsDir } : {}) } as Parameters<typeof pairedEval>[0]);
    res.json({ entry });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** gold 生命周期（T-19）。每次写都是人从界面来的；agent 没有这条路。 */
app.post("/api/gold", (req, res) => {
  try {
    const { capability, file, projectId } = req.body ?? {};
    if (typeof capability !== "string" || !file || typeof projectId !== "string" || !getProject(projectId)) return res.status(400).json({error:"gold_project_and_draft_required"});
    res.status(201).json({state:createGoldDraft(capability,file,projectId)});
  } catch(e) { res.status(400).json({error:(e as Error).message}); }
});
app.get("/api/gold/:capability", (req, res) => {
  try {
    res.json(readGoldState(req.params.capability));
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});
app.post("/api/gold/:capability", (req, res) => {
  const body = (req.body ?? {}) as { action?: "save" | "freeze"; file?: GoldFile; newLineage?: boolean; reviewedItemIds?: string[] };
  try {
    const actor = reviewerPrincipal(req);
    if (body.action === "freeze") return res.json({ frozen: freezeGold(req.params.capability), state: readGoldState(req.params.capability) });
    if (!body.file) return res.status(400).json({ error: "action=save 要给 file（gold.json 的内容）" });
    const saved = saveGold(req.params.capability, body.file, { newLineage: !!body.newLineage, actor, reviewedItemIds: body.reviewedItemIds });
    res.json({ saved, state: readGoldState(req.params.capability) });
  } catch (e) {
    const msg = (e as Error).message;
    res.status(/已冻结/.test(msg) ? 409 : 400).json({ error: msg, ...(/已冻结/.test(msg) ? { code: "FROZEN" } : {}) });
  }
});

/**
 * 仓库里定义好的评测集。
 *
 * `problems` 和 `specs` 一起返回，不静默丢弃坏文件：一份读不出来的定义如果被跳过，
 * 评测集就悄悄变小了，而界面上看起来一切正常。
 */
app.get("/api/evals/specs", (_req, res) => {
  const catalog = listEvalSpecs();
  res.json({ ...catalog, specs: catalog.specs.map(spec => ({ ...spec, preflight: preflightPairedEval(spec) })) });
});

/**
 * 可以当材料喂进去的文档，供 `source.spec` 的 `paths` 勾选。
 *
 * 列出来不等于推荐：选哪几份仍然是人的决定。这里解决的只是"路径拼对了但选错了文档"
 * 这种不会报错、二十分钟后才显形的问题。
 */

// 按 id 跑一份定义好的评测。参数只有 target —— 其余全部来自文件，这是它进仓库的意义：
// 一次可以被随手改掉的评测，量到的是改它的人想看到的东西。
/**
 * 从一条 critic 建议造一份可以直接跑的评测定义。
 *
 * critic 提得出建议，产物却是给人读的文字；而 `evals/*.json` 全部手写。
 * 两头都在，中间没有路——这条路由是那条路。
 * 只有说得出怎么证伪的建议造得出来：一条 manual 的建议造不出两条只差一处的臂。
 */
app.post("/api/evals/specs/from-critique", (req, res) => {
  const body = (req.body ?? {}) as Parameters<typeof specFromSuggestion>[0];
  if (!body?.suggestion?.title) return res.status(400).json({ error: "要给出是哪条建议" });
  if (!body.graphId) return res.status(400).json({ error: "要说清这份评测跑哪张图" });
  try {
    res.json({ spec: specFromSuggestion(body) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/evals/specs/:id/run", (req, res) => {
  const spec = getEvalSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: `没有这份评测定义：${req.params.id}` });
  try {
    const started = startPairedEval({
      graphId: spec.graphId,
      goldPath: spec.goldPath,
      casesNode: spec.casesNode,
      seed: spec.seed,
      target: (req.body as { target?: Parameters<typeof runPairedEval>[0]["target"] } | undefined)?.target,
      a: spec.a,
      b: spec.b,
      spec: { id: spec.id, title: spec.title, why: spec.why, path: spec.path, expect: spec.expect },
    });
    res.status(202).json({ ok: true, spec: spec.id, ...started });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// What an evaluation of this graph would be scored against: version, prompt fingerprint,
// checklist. Three facts that decide whether two results are comparable at all.
app.get("/api/evals/subject/:graphId", (req, res) => res.json(evalSubject(req.params.graphId)));

// Fault injection: run the suite against the healthy build and against each known fault.
app.post("/api/evals/detection", (req, res) => {
  const request = req.body as Parameters<typeof runDetectionEval>[0];
  if (!request?.wfRunId) return res.status(400).json({ error: "wfRunId is required" });
  const started = runDetectionEval(request);
  started.catch(() => undefined);
  res.json({ ok: true, note: "running; each case runs once per build, so this takes a while" });
});

app.get("/api/evals/:id", (req, res) => {
  const found = getEval(req.params.id);
  return found ? res.json({ eval: found }) : res.status(404).json({ error: "unknown eval" });
});

// The critic reads recent runs and proposes harness changes. It proposes only: a
// suggestion that names an ablation switch is settled by a paired evaluation, not by itself.
app.post("/api/critic", async (req, res) => {
  try {
    res.json({ critique: await runCritique(req.body ?? {}) });
  } catch (e) {
    failJson(res, 500, e);
  }
});

/** Score one run against a human-written checklist. */
app.post("/api/evals/score", async (req, res) => {
  try {
    res.json({ score: await scoreRun(req.body as Parameters<typeof scoreRun>[0]) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/critic", (_req, res) => res.json({ critiques: listCritiques() }));

/** What can be switched off, so the UI can offer exactly those and nothing else. */
app.get("/api/ablatable", (_req, res) => res.json({ ablatable: ALL_ABLATABLE }));

/* ---- capabilities (declared external services) ---- */
// A capability is a recipe plus whatever the supervisor knows about the process running
// it. Start/stop go through the process endpoints below — same lifecycle, one owner.
/**
 * 接入就绪清单：**从零到第一批可复核用例，还差哪几条。**
 *
 * 在服务端算而不是让前端拼六次请求，理由是真相在这一侧——守卫的禁止名单与环境开关、环境的登录态、
 * 能力的健康检查、预算的默认值，四样都只有网关知道。前端拼的话会长出第二套口径，
 * 而两套口径最后总会给出两个不同的答案。
 *
 * 每一条只回答两件事：**它现在是什么状态**，以及**为什么是这个状态**。
 * 状态只有四种，因为人要的是「还差几条」，不是一个连续的健康分——
 * 一个 73% 的就绪度，没人知道该先修哪一样。
 *
 * 冷启动那条也在这里回答：库里可能一个项目都没有，而磁盘上躺着几十次历史运行。
 * 界面必须同时说出这两件事，否则第一屏就在自相矛盾。
 */
app.get("/api/readiness", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
  const project = projectId ? getProject(projectId) : undefined;
  const projects = listProjects();
  type State = "none" | "unverified" | "ok" | "broken";
  /*
   * `detail` / `hint` 是**词条 key 加参数**，不是拼好的句子。
   *
   * 此前它们是服务端拼的中文，前端直接 `{it.detail}` 渲染出来——于是英文界面上
   * 会出现「6 个能力，一个都没起」「demo.binance.com 不在白名单里」。
   * `03 §9.5` 的断言点是「切换语言后无硬编码残留」，而这条路绕过了整个 i18n。
   *
   * 纯数据的那几条（项目名 · 地址、模型名 @ 端点）仍然直接给字符串：
   * 它们里面没有一个字需要翻译。
   */
  type Msg = string | { key: string; params?: Record<string, string | number> };
  const items: Array<{ id: string; state: State; detail: Msg; hint?: Msg }> = [];

  items.push(
    project
      ? { id: "project", state: "ok", detail: `${project.name} · ${project.targetUrl}` }
      : {
          id: "project",
          state: "none",
          detail: projects.length ? { key: "ready.projectUnpicked", params: { n: projects.length } } : { key: "ready.projectNone" },
        },
  );

  // 被测对象：地址 + 登录态。地址为空是「坏了」而不是「没配」——环境存在却没有地址，
  // 是一条会在二十分钟后才暴露的失败。
  const envs = projectId ? listEnvironments(projectId) : [];
  const env = envs.find((e) => e.isDefault) ?? envs[0];
  if (!env) items.push({ id: "sut", state: "none", detail: { key: "ready.sutNone" } });
  else if (!env.baseUrl?.trim())
    items.push({
      id: "sut",
      state: "broken",
      detail: { key: "ready.sutNoUrl", params: { name: env.name } },
      hint: { key: "ready.sutNoUrlWhy" },
    });
  else {
    const hasSession = !!env.login?.session;
    items.push({
      id: "sut",
      state: env.login?.authRequired && !hasSession ? "unverified" : "ok",
      detail: hasSession
        ? { key: "ready.sutOkSession", params: { name: env.name, url: env.baseUrl } }
        : `${env.name} · ${env.baseUrl}`,
      hint: env.login?.authRequired && !hasSession ? { key: "ready.sutNeedLogin" } : undefined,
    });
  }

  /**
   * 模型：**把「测的参数」和「跑的参数」摆在一起**。
   *
   * 这两者今天不是同一套：探活那条通道写死 `enable_thinking:false`
   * （`server/src/model.ts` 的 `chatNow`），而图运行时的 `ModelClient` 默认**开**思考
   * （`openai.ts` 的 `noThink: env.TP_MODEL_THINK === "0" ? true : false`）。
   * 于是「绿色的连接通过」与「一整场失败的运行」可以同时成立，
   * 而人没有任何线索去怀疑这两件事测的不是一回事。
   *
   * 在参数装配路径被统一之前，至少要把这个差别说出来。
   */
  const model = resolveModelConfig();
  const runThinks = process.env.TP_MODEL_THINK !== "0";
  items.push(
    model.baseUrl && model.modelName
      ? {
          id: "model",
          state: "unverified",
          detail: `${model.modelName} @ ${model.baseUrl}`,
          hint: { key: runThinks ? "ready.modelThinkMismatch" : "ready.modelThinkOff" },
        }
      : { id: "model", state: "none", detail: { key: "ready.modelNone" } },
  );

  /**
   * 运行时：**绿色只留给健康检查通过**。
   *
   * `spawning` 不算就绪——这一页此前把它画成绿的，而 supervisor 的就绪超时只写
   * `lastError` 不改 state，于是一个健康检查从没通过的服务看起来是健康的。
   */
  const alive = capabilities.filter((c) => supervisor.statusOf(c.id)?.state === "alive");
  const bad = capabilities.filter((c) => {
    const s = supervisor.statusOf(c.id);
    return !!s?.lastError && s.state !== "alive";
  });
  /**
   * **没声明能力就没有这一项。**
   *
   * 这里数的是本机声明的外部服务（基准应用、模型代理这些）。一份干净安装一个都没有，
   * 而清单上却写着「6 个能力，一个都没起」——2026-09-16 看这一屏时，它像是装坏了，
   * 其实什么都不缺。有声明才问它们起没起。
   */
  if (capabilities.length)
    items.push(
      bad.length
        ? {
            id: "runtime",
            state: "broken",
            detail: { key: "ready.runtimeBroken", params: { id: bad[0]!.id } },
            // lastError 是子进程自己说的话，原样带出去：它是给人拿去搜的那一截。
            hint: String(supervisor.statusOf(bad[0]!.id)?.lastError ?? "").slice(0, 160),
          }
        : alive.length
          ? { id: "runtime", state: "ok", detail: { key: "ready.runtimeOk", params: { a: alive.length, n: capabilities.length } } }
          : { id: "runtime", state: "none", detail: { key: "ready.runtimeNone", params: { n: capabilities.length } } },
    );

  /**
   * 规划：Web 发起生成时由谁写故事和用例（`TP_AGENT_RUNTIME`，不设是 Claude Code）。
   * 只查本机起不起得来、不查登录态；起不来时建运行会被当场拒绝，所以要在第一屏就说出来。
   */
  {
    const planner = defaultRuntimeName();
    items.push(plannerRuntimeAvailable(planner)
      ? { id: "planner", state: "ok", detail: { key: "ready.plannerOk", params: { runtime: planner } } }
      : { id: "planner", state: "broken", detail: { key: "ready.plannerMissing", params: { runtime: planner } },
          hint: planner === "claude-code" ? "claude --version" : "TP_PENGUIN_BIN" });
  }

  /**
   * 守卫：被测地址在禁止名单上就什么都不跑；环境没勾「允许不可逆」时，命中删除/支付/结账
   * 等词的步骤会被一律拒绝。这件事必须在跑之前说出来，否则人会在执行报告里
   * 看到一堆没有理由的失败。
   */
  const host = (() => {
    try {
      return new URL(env?.baseUrl || project?.targetUrl || "").hostname;
    } catch {
      return "";
    }
  })();
  items.push(
    !host
      ? { id: "guard", state: "none", detail: { key: "ready.guardNoHost" } }
      : config.guard.denyHosts.includes(host)
        ? { id: "guard", state: "broken", detail: { key: "ready.guardDenied", params: { host } } }
        : { id: "guard", state: "ok", detail: { key: "ready.guardOk", params: { host } } },
  );

  const b = config.budget;
  items.push({
    id: "budget",
    state: "ok",
    detail: {
      key: b.usd ? "ready.budget" : "ready.budgetNoCap",
      params: { calls: b.calls ?? "—", usd: b.usd ?? 0, min: Math.round((b.ms ?? 0) / 60000) },
    },
    hint: { key: "ready.budgetHint" },
  });

  res.json({
    items,
    okCount: items.filter((i) => i.state === "ok").length,
    total: items.length,
    // 冷启动要同时说出这两件事，否则第一屏会自相矛盾。
    projects: projects.length,
    historicalRuns: outputStore.listRuns(500).length,
  });
});

app.get("/api/capabilities", (_req, res) => {
  res.json({
    capabilities: capabilities.map((c) => ({
      ...c,
      env: undefined, // a recipe's env may carry credentials; the UI never needs it
      status: supervisor.statusOf(c.id) ?? null,
      /*
       * 工作目录在不在。
       *
       * 它是这条配方里唯一**换一台机器就会失效**的字段：基准应用装在某个人的
       * `~/bench/...` 下，而症状是「启动了、立刻退出」——一个没有任何线索指向路径的症状。
       * 先说出来，比让人去读退出码强。
       */
      cwdMissing: !!c.cwd && !existsSync(c.cwd),
    })),
  });
});

/**
 * 改一条能力的工作目录。
 *
 * 只开放这一个字段：命令与参数是配方的定义，改它们等于换一条能力；
 * 而 cwd 是一个本机事实，配置文件里那个写死的路径在别人的机器上一定不对。
 */
app.patch("/api/capabilities/:id/cwd", (req, res) => {
  const cwd = req.body?.cwd;
  if (typeof cwd !== "string" || !cwd.trim())
    return res.status(400).json({ error: "cwd 得是一个非空路径" });
  try {
    res.json({ capability: setCapabilityCwd(req.params.id, cwd.trim()) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Add a capability at runtime — the end of the chat's draft → check → save → start chain.
 *
 * Validated here again rather than trusting the draft the client is holding: between the
 * check and the save the recipe lives in a browser, and a command this machine will run is
 * not something to take on trust from there.
 */
app.post("/api/capabilities", (req, res) => {
  try {
    const recipe = validRecipeOrThrow(req.body?.recipe ?? req.body, takenProcessIds());
    res.json({ capability: addCapability(recipe), status: supervisor.statusOf(recipe.id) ?? null });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/* ---- chat with the agent ---- */
// It drafts; it never applies. Saving a draft is a separate call, and one a person makes.
app.post("/api/chat", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      messages?: Array<{ role: "user" | "assistant"; text: string }>;
      intent?: ChatIntent;
      graphId?: string;
      promptKey?: string;
      /** 起草哪个复杂字段（intent "field"）。 */
      field?: string;
      /** 上一轮的草稿：这一轮是改它，不是重写。 */
      previous?: unknown;
      context?: ChatContext;
      projectId?: string;
    };
    if (!body.messages?.length) return res.status(400).json({ error: "messages is required" });
    res.json(
      await chat({
        messages: body.messages,
        intent: body.intent ?? "ask",
        graphId: body.graphId,
        promptKey: body.promptKey,
        field: body.field,
        previous: body.previous,
        projectId: body.projectId,
        // What the person has selected on the canvas. Read server-side into the prompt, so a
        // question about "this step" is answered against that step's real parameters and output.
        context: body.context,
        existingIds: takenProcessIds(),
      }),
    );
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 起草面开场：有哪些字段可以聊出来，以及这个项目哪几次运行手里有材料。
 *
 * 只读。**没有「应用」这一路**——一个字段聊出来之后走的是它自己本来那条保存路径
 * （规则包走 `POST /api/projects/:id/rule-packs`，那里有 `validateRulePack`），
 * 而不是另开一个专给聊天用的入口。多一条入口就多一份会和主路径走岔的校验。
 */
app.get("/api/chat/fields", (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  if (!projectId) return res.status(400).json({ error: "projectId is required" });
  try {
    res.json(fieldSources(projectId));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Save a chat-drafted prompt. The plain settings endpoint takes any text a person types —
 * that is theirs to get wrong — but a rewrite that came from a model goes through the
 * placeholder check first, because a dropped `${...}` is invisible until a run needs it.
 */
app.post("/api/chat/apply-prompt", (req, res) => {
  try {
    const key = String(req.body?.key ?? "");
    const check = checkPrompt(req.body?.prompt, key);
    if (!check.valid) return res.status(400).json({ error: check.issues.join("; "), issues: check.issues });
    res.json({ settings: updateSettings({ prompts: { [key]: String(req.body?.prompt) } as never }) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Save a chat-drafted graph. Same validation and the same new-version rule as the canvas. */
app.post("/api/chat/apply-graph", (req, res) => {
  try {
    res.json({ graph: applyGraphDraft(req.body?.graph, req.body?.note) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/* ---- processes (supervisor) ---- */
// Read model: the UI renders whatever the supervisor reports; live changes arrive as
// `process.status` events over /ws, so this endpoint is only the initial snapshot.
app.get("/api/processes", (_req, res) => res.json({ processes: processStatuses() }));

// Stop the work without killing the process: interactive sessions cancel cooperatively.
// A case run in progress cannot be interrupted yet, so the response says so plainly
// rather than pretending it stopped.
app.post("/api/processes/:id/cancel-work", async (req, res) => {
  try {
    res.json(await cancelRunnerWork(req.params.id));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/processes/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (id === "gateway")
    return res.status(400).json({ error: "the gateway supervises the others; it cannot supervise itself" });
  if (!supervisor.statusOf(id)) return res.status(404).json({ error: `unknown process: ${id}` });
  try {
    if (action === "start") await supervisor.start(id);
    else if (action === "stop") await supervisor.stop(id);
    else if (action === "restart") await supervisor.restart(id);
    else return res.status(400).json({ error: `unknown action: ${action}` });
    res.json({ process: supervisor.statusOf(id) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// The evaluation module executes cases; the gateway is what owns the bindings and runners.
setCaseExecutor((target, kase, fragments) => executeCaseDirect(target, kase, fragments as never));
for (const [id, d] of Object.entries(DEFECTS)) DEFECT_TITLES[id] = d.title;

seedIfEmpty();
bus.subscribe(event => { void projectWorkflowEvent(event).catch(error => log(`run projection failed: ${(error as Error).message}`)); });
await recoverRunProjections();
recoverWorkflowExecutions();
recoverPreparations();
await flushDecisionDelivery();
const decisionDeliveryTimer = setInterval(() => { void flushDecisionDelivery().catch(() => log("decision delivery pending")); }, 5000);
decisionDeliveryTimer.unref();
const httpServer = app.listen(PORT, () => log(`server listening on http://localhost:${PORT}`));
attachWs(httpServer, bus, log);
// Called from here, not from procs.ts: the process module must not depend on the workflow
// module, or the two import each other and neither finishes initialising.
reconcileOrphanedRuns(log);
reconcileOrphanedEvals(log);
recoverStudies();
// Penguin 那条路的同一件事：session 在 :7364 上还跑着，看门狗却随网关一起没了。
reconcilePenguinRuns(log);
void startProcesses(log);
