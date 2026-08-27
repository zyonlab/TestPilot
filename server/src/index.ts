import express from "express";
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
} from "./exec.js";
import { checkRun, classifyFailure, MachineOracleSchema } from "@testpilot/harness-testing";
import { ALL_ABLATABLE, validateGraph, describeDiff } from "@testpilot/harness-core";
import { approve, batchAdjust, editCase, pendingRuns, regenerate, reject, reviewBatch } from "./review.js";
import {
  DEFECT_TITLES,
  evalSubject,
  getEval,
  listCritiques,
  listEvals,
  reconcileOrphanedEvals,
  runCritique, scoreRun,
  runDetectionEval,
  runPairedEval,
  setCaseExecutor,
} from "./evals.js";
import { getEvalSpec, listEvalSpecs } from "./evalspecs.js";
import { listMaterials } from "./materials.js";
import {
  activeRuns,
  allOutputs,
  cancelRun,
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
} from "./graphs.js";

// The guard runs where the whole picture is known (url + login + steps + teardown), i.e.
// here, before anything is dispatched. A refusal is loud and recorded: silently skipping
// a step would surface as a passing run, which is worse than refusing.
function guardRun(url: string, steps: string[]): void {
  const v = checkRun(url, steps, config.guard);
  if (!v.allow) {
    const err = new Error(`blocked by the guard: ${v.why}`) as Error & { code?: string };
    err.code = v.code;
    throw err;
  }
}

// Error responses carry the same code the run records store, so a caller can tell an
// environment problem from a real failure without parsing prose (docs/spec/06 §2).
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
  capabilities,
  config,
  modelGate,
  processStatuses,
  startProcesses,
  supervisor,
  takenProcessIds,
} from "./procs.js";
import { applyGraphDraft, chat, checkPrompt, validRecipeOrThrow, type ChatContext, type ChatIntent } from "./chat.js";
import { changes, codeLine, codeProvenance } from "./codeline.js";
import { traceability } from "./trace.js";
import { pendingBaselines } from "./pending.js";
import { continuationsFor, continueRun } from "./continue.js";
import {
  PORT,
  resolveModelConfig,
  resolveChainConfig,
  setChainConfig,
} from "./config.js";
import { probeModel, generateCode, refineCase } from "./model.js";
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
import { seedIfEmpty } from "./seed.js";
import { buildExportFiles } from "./export.js";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  createReadStream,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const MIDSCENE_DIR = resolve(process.cwd(), "midscene_run");
const VISUAL_THRESHOLD = 0.5; // % mismatch above which a step is flagged as a visual diff

// Compare a run's step screenshots against per-step visual baselines; save current/diff
// artifacts and return the diff results. First run for a case establishes the baselines.
function processVisual(caseId: string, runId: string, pngBuffers: Buffer[]): VisualDiff[] {
  const out: VisualDiff[] = [];
  for (let i = 0; i < pngBuffers.length; i += 1) {
    const cur = pngBuffers[i];
    const currentRef = `current/${runId}-${i}.png`;
    writeFileSync(resolve(ARTIFACT_DIR, currentRef), cur);
    const baseline = getBaseline(caseId, i);
    if (!baseline || !existsSync(baseline.imgPath)) {
      const blPath = resolve(ARTIFACT_DIR, "baselines", `${caseId}-${i}.png`);
      writeFileSync(blPath, cur);
      upsertBaseline(caseId, i, blPath);
      out.push({
        stepIdx: i,
        status: "new_baseline",
        mismatchPct: 0,
        baselineRef: `baselines/${caseId}-${i}.png`,
        currentRef,
      });
      continue;
    }
    const d = diffPng(readFileSync(baseline.imgPath), cur);
    const diffRef = `diff/${runId}-${i}.png`;
    writeFileSync(resolve(ARTIFACT_DIR, diffRef), d.diffPng);
    out.push({
      stepIdx: i,
      status: d.mismatchPct > VISUAL_THRESHOLD ? "diff" : "match",
      mismatchPct: d.mismatchPct,
      baselineRef: `baselines/${caseId}-${i}.png`,
      currentRef,
      diffRef,
    });
  }
  return out;
}


const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
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
app.get("/api/projects", (_req, res) =>
  res.json({
    projects: listProjects().map((p) => ({ ...p, cases: listCases(p.id).length })),
  }));
const PLATFORMS = ["web", "ios", "android"] as const;
type Platform = (typeof PLATFORMS)[number];
const asPlatform = (v: unknown): Platform | undefined =>
  PLATFORMS.includes(v as Platform) ? (v as Platform) : undefined;

app.post("/api/projects", (req, res) => {
  const { name, targetUrl, targetPlatform } = req.body ?? {};
  if (!name || !targetUrl) return res.status(400).json({ error: "name and targetUrl required" });
  if (targetPlatform !== undefined && !asPlatform(targetPlatform))
    return res.status(400).json({ error: `targetPlatform must be one of ${PLATFORMS.join(", ")}` });
  res.json({
    project: createProject(String(name), String(targetUrl), asPlatform(targetPlatform) ?? "web"),
  });
});
// Renaming, re-pointing, or switching ends. Switching to iOS/Android does not delete the
// web3 settings already on the cases: it hides the controls, and switching back finds them
// where they were. Silently dropping a user's configuration on a dropdown change would be
// a worse surprise than a hidden field.
app.patch("/api/projects/:id", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  const { name, targetUrl, targetPlatform } = req.body ?? {};
  if (targetPlatform !== undefined && !asPlatform(targetPlatform))
    return res.status(400).json({ error: `targetPlatform must be one of ${PLATFORMS.join(", ")}` });
  const project = updateProject(req.params.id, {
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(targetUrl !== undefined ? { targetUrl: String(targetUrl) } : {}),
    ...(targetPlatform !== undefined ? { targetPlatform: asPlatform(targetPlatform)! } : {}),
  });
  res.json({ project });
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
  const c = updateCase(req.params.id, req.body ?? {});
  if (!c) return res.status(404).json({ error: "case not found" });
  res.json({ case: c });
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
app.get("/api/projects/:id/export", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const files = buildExportFiles(project, listCases(project.id), {
    environments: listEnvironments(project.id),
    secretKeys: listSecretMeta(project.id).map((s) => s.key),
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
    const { code } = { code: await generateCode(c.title, c.steps.map((s) => s.text), c.priorityReason) };
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
    env?.login?.authRequired && !useSession && !body?.skipLogin ? env.login.steps ?? [] : [];
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

  guardRun(url, [...login, ...c.steps.map((s) => s.text), ...c.postSteps.map((s) => s.text)]);
  const exec = await execOnRunner({
    execId: `${c.id}-${Date.now()}`,
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
      login,
      web3,
      postSteps: c.postSteps.map((s) => s.text),
      resolve: ctx,
      rowLabel: body?.__rowLabel,
      // Fixed headers + any auth header captured by API login (when the session is used).
      extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(useSession ? session?.headers ?? {} : {}) },
      query: resolveMap(env?.query ?? {}, ctx),
      storageState: useSession ? session : null,
      oracle: c.oracle,
    },
  });
  // Pixels come back as files; the gateway is the only side that knows the baselines.
  const pngBuffers = readPngs(exec.pngPaths);
  const result = { ...exec, pngBuffers, screenshots: toDataUrls(pngBuffers) };

  const perf = comparePerf(result.perfMetrics, getPerfBaseline(c.id), {});
  if (perf.status === "new_baseline" && Object.keys(result.perfMetrics).length > 0) {
    upsertPerfBaseline(c.id, result.perfMetrics);
  }
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
  const report = captureMidsceneReport({
    midsceneDir: MIDSCENE_DIR,
    sinceMs: result.sinceMs,
    destPath: resolve(ARTIFACT_DIR, "reports", `${run.id}.html`),
  });
  const visual = processVisual(c.id, run.id, result.pngBuffers);
  updateRunResults(run.id, { reportPath: report.reportPath, tokens: report.tokens, visual, perf, oracle: result.oracle });
  run.reportPath = report.reportPath;
  run.tokens = report.tokens;
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
  const dataset = c.dataKey ? env?.vars?.[c.dataKey] : undefined;
  const rows = Array.isArray(dataset) ? dataset : null;
  if (!rows || !rows.length) return runCaseWithHeal(c, body, maxRetries);

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
    });
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

  const live = interactiveSession(`dbg-${c.id}`);
  const off = live.onFrame(send);
  let closed = false;
  req.on("close", () => {
    closed = true;
    off();
    void live.cancel();
  });

  try {
    if (!url) throw new Error("no url (set an environment baseUrl or project targetUrl)");
    guardRun(url, plan.map((p) => p.text));
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
function observeLaunch(projectId: string): {
  extraHeaders: Record<string, string>;
  query: Record<string, string>;
  storageState: StorageState | null;
} {
  const env = resolveEnvironment(projectId);
  const ctx: ResolveContext = { env: env?.vars ?? {}, secrets: getSecretValues(projectId) };
  const session = env?.login?.session ?? null;
  return {
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(session?.headers ?? {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: session,
  };
}

/**
 * 让 `source.explore` 节点能看一眼跑着的产品。
 *
 * 复用探索那套浏览器会话，但**要的是观察，不是用例**：给模型的提示词在节点那边，
 * 这里只负责把界面上看得见的东西取回来。观察与解读分开，是因为它们会各自变化——
 * 换一套观察方式不该重写提示词，改一句提示词也不该重开浏览器。
 */
setAgentObserver(async (input) => {
  const { url, deep, settleMs, projectId } = (input ?? {}) as {
    url?: string;
    deep?: boolean;
    settleMs?: number;
    projectId?: string;
  };
  const project = projectId ? getProject(projectId) : undefined;
  const target = url || project?.targetUrl;
  if (!target) throw new Error("source.explore has no address to open: give it a url, or bind the run to a project");

  const live = interactiveSession(`observe-${projectId ?? "adhoc"}`);
  // 走 observe 而不是 explore：explore 的契约是"返回解析出来的 flows"，把散文喂进它
  // 只会被 `asArray()` 压成 []。观察要的是屏幕上原样的东西，采集是确定性的。
  const result = await live.observe(
    {
      url: target,
      deep,
      settleMs,
      launch: { cacheId: `observe-${projectId ?? "adhoc"}`, ...(projectId ? observeLaunch(projectId) : {}) },
    },
    ARTIFACT_DIR,
  );
  return { notes: result.notes.slice(0, 24000), url: result.url };
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
  const { name, baseUrl, vars, headers, query, login, isDefault } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const environment = upsertEnvironment({
    projectId: req.params.id,
    id: req.body?.id,
    name,
    baseUrl: baseUrl ?? "",
    vars: vars ?? {},
    headers: headers ?? {},
    query: query ?? {},
    // No `session` key here → upsert preserves any captured session.
    login: login ?? {},
    isDefault: !!isDefault,
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
        try {
          const { run, attempts, healed } = await runCaseDataDriven(c, req.body ?? {}, retries);
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
  const gate: Batch["gate"] = failed > 0 || errored > 0 ? "fail" : "pass";
  updateBatch(batch.id, {
    status: "done",
    total: items.length,
    passed,
    failed,
    healed,
    flaky,
    quarantined,
    errored,
    gate,
    finishedAt: new Date().toISOString(),
  });
  res.json({ batch: getBatch(batch.id), items, gate });
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
app.get("/api/events", (req, res) => {
  const sinceId = Math.max(0, Number(req.query.sinceId) || 0);
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  let events = bus.replay(sinceId, 10_000);
  if (kind) events = events.filter((e) => e.kind === kind);
  res.json({ head: bus.head(), events: events.slice(-limit) });
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
    res.json(
      await startRun({
        ...body,
        // A run states what it ran against. Without that, "these cases passed" is a claim
        // about nothing in particular.
        target: body.target ?? { projectId: body.projectId, envRef: body.envRef, url: body.url },
      }),
    );
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
  try {
    res.json(
      await startRun({
        graphId: String(run.graphId),
        wfRunId: req.params.id,
        mode: { kind: mode, node: req.params.nodeId },
        seed: req.body?.seed,
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
    res.json(await continueRun(req.params.id, String((req.body ?? {}).graphId ?? "")));
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

app.post("/api/wf/runs/:id/resume", async (req, res) => {
  try {
    res.json(await resumeRun(req.params.id));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/wf/runs/:id/cancel", async (req, res) =>
  res.json({ cancelled: await cancelRun(req.params.id) }));

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
  res.json(pendingBaselines(req.params.id));
});

app.get("/api/projects/:id/traceability", async (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  try {
    res.json(await traceability(req.params.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/cases/:id/code", async (req, res) => {
  try {
    res.json({ provenance: await codeProvenance(req.params.id) });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
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

app.post("/api/review/:wfRunId/reject", (req, res) => {
  try {
    res.json({ rejected: reject({ wfRunId: req.params.wfRunId, ...(req.body ?? {}) }) });
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
    const started = runPairedEval(request);
    started.catch(() => undefined); // failures are recorded on the eval row
    res.json({ ok: true, note: "running; watch eval.* events or poll /api/evals" });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/evals", (_req, res) => res.json({ evals: listEvals() }));

/**
 * 仓库里定义好的评测集。
 *
 * `problems` 和 `specs` 一起返回，不静默丢弃坏文件：一份读不出来的定义如果被跳过，
 * 评测集就悄悄变小了，而界面上看起来一切正常。
 */
app.get("/api/evals/specs", (_req, res) => res.json(listEvalSpecs()));

/**
 * 可以当材料喂进去的文档，供 `source.spec` 的 `paths` 勾选。
 *
 * 列出来不等于推荐：选哪几份仍然是人的决定。这里解决的只是"路径拼对了但选错了文档"
 * 这种不会报错、二十分钟后才显形的问题。
 */
app.get("/api/materials", (_req, res) => res.json(listMaterials()));

// 按 id 跑一份定义好的评测。参数只有 target —— 其余全部来自文件，这是它进仓库的意义：
// 一次可以被随手改掉的评测，量到的是改它的人想看到的东西。
app.post("/api/evals/specs/:id/run", (req, res) => {
  const spec = getEvalSpec(req.params.id);
  if (!spec) return res.status(404).json({ error: `没有这份评测定义：${req.params.id}` });
  try {
    const started = runPairedEval({
      graphId: spec.graphId,
      goldPath: spec.goldPath,
      casesNode: spec.casesNode,
      seed: spec.seed,
      target: (req.body as { target?: Parameters<typeof runPairedEval>[0]["target"] } | undefined)?.target,
      a: spec.a,
      b: spec.b,
      spec: { id: spec.id, title: spec.title, why: spec.why, path: spec.path, expect: spec.expect },
    });
    started.catch(() => undefined);
    res.json({ ok: true, spec: spec.id, note: "running; watch eval.* events or poll /api/evals" });
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
app.get("/api/capabilities", (_req, res) => {
  res.json({
    capabilities: capabilities.map((c) => ({
      ...c,
      env: undefined, // a recipe's env may carry credentials; the UI never needs it
      status: supervisor.statusOf(c.id) ?? null,
    })),
  });
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
      context?: ChatContext;
    };
    if (!body.messages?.length) return res.status(400).json({ error: "messages is required" });
    res.json(
      await chat({
        messages: body.messages,
        intent: body.intent ?? "ask",
        graphId: body.graphId,
        promptKey: body.promptKey,
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
const httpServer = app.listen(PORT, () => log(`server listening on http://localhost:${PORT}`));
attachWs(httpServer, bus, log);
// Called from here, not from procs.ts: the process module must not depend on the workflow
// module, or the two import each other and neither finishes initialising.
reconcileOrphanedRuns(log);
reconcileOrphanedEvals(log);
void startProcesses(log);
