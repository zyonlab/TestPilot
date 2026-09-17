/**
 * Hyperliquid **测试网** /trade 的领域引导探索（docs/v3/history/22 阶段 E；地址口径见 docs/v3/history/24 §15）。
 *
 * 默认地址是测试网 `app.hyperliquid-testnet.xyz`，不是主网——主网上同一串点击是在花真钱，
 * 而两者只差一个域名。要跑主网必须显式给 `TP_TARGET_URL`，并且自己想清楚为什么。
 *
 * 只读：charter 里 state-change 的目标（Place Order / Close / Deposit / Withdraw / Connect）
 * 在被发现的那一刻就记 blocked，永远不点；浏览器是全新的无扩展 profile，没有钱包、没有会话，
 * 所以即使规则失效也签不了任何东西。goto 限在 /trade 一条路由，全局导航不吃预算。
 *
 * 产出冻结材料给两条规划臂共用：exploration-report.json / product-model.json /
 * state-flow-graph.json / exploration.md / product-model.md。需要 --real。
 */
import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runObserve } from "@testpilot/harness-testing/exec";
import { buildProductModel, charterFromRulePack, describeProductModel, validateRulePack } from "@testpilot/harness-testing/domain";
import { executorConnectionFromEnv } from "@testpilot/harness-core";

const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
if (!process.argv.includes("--real")) throw new Error("--real required");
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(root, "docs/v3/evidence/hl-mainnet-2026-09-11/explore"));
mkdirSync(out, { recursive: true });

const packFile = join(root, "fixtures/hyperliquid-mainnet/rules.json");
const v = validateRulePack(JSON.parse(readFileSync(packFile, "utf8")));
if (!v.ok) throw new Error(`rule pack invalid: ${JSON.stringify(v.errors.slice(0, 5))}`);
const url = process.env.TP_TARGET_URL ?? "https://app.hyperliquid-testnet.xyz/trade";
const maxScreens = Number(process.env.TP_MAX_SCREENS ?? 20);
const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: url, maxScreens, id: "charter-hl-mainnet" });
if (charter.featureTargets.some((t) => t.sideEffect === "state-change" && t.action !== "activate"))
  throw new Error("unexpected charter shape");

const log: string[] = [];
const started = Date.now();
const r = await runObserve(
  {
    execId: "hl-mainnet-explore", url, artifactDir: out, charter, deep: true, maxScreens,
    settleMs: 1500, maxSettleMs: 20_000, scenarioFirst: false,
    launch: { headless: true, viewport: { width: 1600, height: 1000 }, executorModel: executorConnectionFromEnv(),
      cacheId: `hl-mainnet-${Date.now()}`, modelBudget: { maxCalls: 3, deadlineAt: Date.now() + 900_000 } } as never,
  },
  (evt) => { if (evt.type === "log") { const m = String(evt.message); log.push(m); console.log(m); } },
);
if (!r.report) throw new Error("no exploration report");
const model = buildProductModel({ pack: v.pack, report: r.report });
writeFileSync(join(out, "exploration-report.json"), JSON.stringify(r.report, null, 2));
writeFileSync(join(out, "product-model.json"), JSON.stringify(model, null, 2));
writeFileSync(join(out, "state-flow-graph.json"), JSON.stringify(r.graph, null, 2));
writeFileSync(join(out, "exploration.md"), r.notes);
writeFileSync(join(out, "product-model.md"), describeProductModel(model));
writeFileSync(join(out, "log.txt"), log.join("\n"));
const activated = r.report.observations.filter((o) => o.status === "attempted").map((o) => o.targetSpecId);
const stateChangeTargets = charter.featureTargets.filter((t) => t.sideEffect === "state-change").map((t) => t.id);
const violated = activated.filter((id) => stateChangeTargets.includes(id));
const summary = {
  at: new Date().toISOString(), url, minutes: Math.round((Date.now() - started) / 60000),
  rulePack: { id: v.pack.id, version: v.pack.version, hash: v.hash, sha256OfFile: createHash("sha256").update(readFileSync(packFile)).digest("hex") },
  materialsHash: createHash("sha256").update(r.notes).digest("hex"),
  completion: r.report.completion, stop: r.report.stopReason, coverage: r.report.coverage, summary: model.summary,
  conflicts: model.conflicts.map((c) => c.ruleId), plannedTargets: r.report.plannedTargets.map((p) => `${p.targetSpecId}:${p.status}${p.reason ? `(${p.reason})` : ""}`),
  noStateChangeActivated: violated.length === 0, violated, screens: r.screens, stoppedBecause: r.stoppedBecause,
};
writeFileSync(join(out, "result.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (violated.length) process.exit(1);
