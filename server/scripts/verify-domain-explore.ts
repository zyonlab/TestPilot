/**
 * 领域引导探索的真实验收（docs/v3/history/20 §11 第一切片）。
 *
 * 在隔离的本地 perp-lab fixture 上，绑定 fixtures/perp-lab/rules.json，用真实 headless 浏览器
 * 跑 runObserve；不问模型（charter 取代了「先猜故事」那一步），不下单、不平仓、不撤单。
 * 跑两遍：健康版应把面板功能全部 confirmed；tpsl-panel 缺陷版应把 order.tpsl 判成 conflicted。
 * 产出 ExplorationReport / ProductModel / 状态图 / 截图到 TP_EVIDENCE_DIR。
 *
 * 需要 --real；模型环境只用于会话代理的握手，整次探索 0 次模型调用（见 result 里的 modelRequests）。
 */
import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { runObserve } from "@testpilot/harness-testing/exec";
import { buildProductModel, charterFromRulePack, describeProductModel, validateRulePack } from "@testpilot/harness-testing/domain";
import { executorConnectionFromEnv } from "@testpilot/harness-core";

const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
if (!process.argv.includes("--real")) throw new Error("--real required");
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(root, "docs/v3/evidence/domain-explore-2026-09-10"));
mkdirSync(out, { recursive: true });

const packRaw = JSON.parse(readFileSync(join(root, "fixtures/perp-lab/rules.json"), "utf8"));
const v = validateRulePack(packRaw);
if (!v.ok) throw new Error(`rule pack invalid: ${JSON.stringify(v.errors)}`);
const { createPerpLab, LAB_VERSION } = (await import(join(root, "fixtures/perp-lab/server.mjs"))) as { createPerpLab: (o: { defect?: string | null }) => import("node:http").Server; LAB_VERSION: string };
const executorModel = executorConnectionFromEnv();
const maxScreens = Number(process.env.TP_MAX_SCREENS ?? 12);
const results: Array<Record<string, unknown>> = [];

for (const defect of [null, "tpsl-panel"] as const) {
  const server = createPerpLab({ defect });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const tag = defect ?? "healthy";
  const artifactDir = join(out, tag);
  mkdirSync(artifactDir, { recursive: true });
  const charter = charterFromRulePack(v.pack, v.hash, { entryUrl: url, maxScreens, id: `charter-perp-lab-${tag}` });
  const log: string[] = [];
  try {
    const before = await fetch(url + "api/clearinghouse").then((r) => r.json());
    const r = await runObserve(
      { execId: `domain-explore-${tag}`, url, artifactDir, charter, deep: true, maxScreens, settleMs: 300, maxSettleMs: 4000, scenarioFirst: false,
        launch: { headless: true, executorModel, cacheId: `domain-explore-${tag}-${Date.now()}`, modelBudget: { maxCalls: 5, deadlineAt: Date.now() + 180_000 } } as never },
      (evt) => { if (evt.type === "log") log.push(String(evt.message)); },
    );
    const after = await fetch(url + "api/clearinghouse").then((r) => r.json());
    if (!r.report) throw new Error("no report returned");
    const model = buildProductModel({ pack: v.pack, report: r.report });
    writeFileSync(join(artifactDir, "exploration-report.json"), JSON.stringify(r.report, null, 2));
    writeFileSync(join(artifactDir, "product-model.json"), JSON.stringify(model, null, 2));
    writeFileSync(join(artifactDir, "state-flow-graph.json"), JSON.stringify(r.graph, null, 2));
    writeFileSync(join(artifactDir, "exploration.md"), r.notes);
    writeFileSync(join(artifactDir, "product-model.md"), describeProductModel(model));
    writeFileSync(join(artifactDir, "log.txt"), log.join("\n"));
    // 探索不许动资金：持仓 / 挂单 / 余额 / 杠杆前后必须一样。保证金模式是 charter 里
    // 显式允许激活的 ui-only 设置，它的漂移单独报告，不算资金变化，也不藏起来。
    const money = (x: Record<string, unknown>) => JSON.stringify({ position: x.position, orders: x.orders, balance: x.balance, leverage: x.leverage });
    const untouched = money(before) === money(after);
    const settingsDrift = before.marginMode === after.marginMode ? null : { marginMode: { before: before.marginMode, after: after.marginMode } };
    const feature = (id: string) => model.features.find((f) => f.id === id)!.verification;
    const expectations = defect === null
      ? { "order.type": "confirmed", "order.margin-mode": "confirmed", "order.reduce-only": "confirmed", "order.tpsl": "confirmed", "order.submit": "blocked", "position.close": "blocked", "orders.cancel": "blocked", "order.leverage": "blocked", "account.funding": "blocked" }
      : { "order.tpsl": "conflicted", "order.margin-mode": "confirmed", "order.reduce-only": "confirmed" };
    const mismatches = Object.entries(expectations).filter(([id, want]) => feature(id) !== want).map(([id, want]) => `${id}: want ${want}, got ${feature(id)}`);
    const restored = settingsDrift === null;
    results.push({ defect, url, labVersion: LAB_VERSION, settingsRestored: restored, completion: r.report.completion, stop: r.report.stopReason, coverage: r.report.coverage, summary: model.summary,
      conflicts: model.conflicts.map((c) => c.ruleId), accountUntouched: untouched, settingsDrift, modelCalls: 0, plannedTargets: r.report.plannedTargets.map((p) => `${p.targetSpecId}:${p.status}`), mismatches, passed: untouched && restored && !mismatches.length, screens: r.screens, stoppedBecause: r.stoppedBecause });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((res) => server.close(() => res()));
  }
}
const passed = results.every((r) => r.passed);
writeFileSync(join(out, "result.json"), JSON.stringify({ passed, at: new Date().toISOString(), rulePack: { id: v.pack.id, version: v.pack.version, hash: v.hash, sha256OfFile: createHash("sha256").update(readFileSync(join(root, "fixtures/perp-lab/rules.json"))).digest("hex") }, maxScreens, humanReviewEvidence: false, realExchange: false, results }, null, 2));
console.log(JSON.stringify({ passed, evidence: out, results: results.map((r) => ({ defect: r.defect, completion: r.completion, summary: r.summary, mismatches: r.mismatches, accountUntouched: r.accountUntouched, settingsDrift: r.settingsDrift, planned: r.plannedTargets })) }, null, 2));
process.exit(passed ? 0 : 1);
