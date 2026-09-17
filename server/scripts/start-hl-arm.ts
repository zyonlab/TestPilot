/**
 * 用冻结的主网探索材料创建一条规划 run（docs/v3/history/22 阶段 F/G）。
 *
 * 两条臂共用同一份材料、同一个规则包、同一个产品模型；差别只有一件事：谁来规划。
 *   --arm penguin  → Web run，托管 Penguin 按单元循环规划
 *   --arm host     → 宿主 run（Claude 本人通过网关领单元），只注册与绑定，不启动任何子进程
 * 都不下单、不执行；跑完停在 waiting_review。
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const arm = arg("arm");
if (arm !== "penguin" && arm !== "host") throw new Error("--arm penguin|host required");
const evidence = resolve(arg("evidence") ?? join(root, "docs/v3/evidence/hl-mainnet-2026-09-11/explore"));

const { createProject, listProjects } = await import("../src/db.js");
const { runLedger, registerHostRun } = await import("../src/runService.js");
const { createWebWorkflow } = await import("../src/workflowOps.js");

const name = arg("projectName") ?? "Hyperliquid Mainnet (unit-loop compare)";
const wanted = arg("project");
const project = (wanted ? listProjects().find((p) => p.id === wanted) : undefined)
  ?? listProjects().find((p) => p.name === name) ?? createProject(name, "https://app.hyperliquid-testnet.xyz/trade");
const pack = JSON.parse(readFileSync(join(root, "fixtures/hyperliquid-mainnet/rules.json"), "utf8"));
const model = JSON.parse(readFileSync(join(evidence, "product-model.json"), "utf8"));
const report = JSON.parse(readFileSync(join(evidence, "exploration-report.json"), "utf8"));
const explorationMd = readFileSync(join(evidence, "exploration.md"), "utf8");
const productMd = readFileSync(join(evidence, "product-model.md"), "utf8");
const materials = [
  { name: "exploration.md", text: explorationMd },
  { name: "product-model.md", text: productMd },
];
const materialsHash = createHash("sha256").update(materials.map((m) => m.text).join("\n")).digest("hex");

if (arm === "penguin") {
  const created = await createWebWorkflow(project.id, {
    idempotencyKey: `hl-penguin-${arg("key") ?? "1"}`, sourceKind: "spec", outputLanguage: "zh",
    materials, rulePacks: [pack], workUnits: true, importProductModel: model, limit: Number(arg("limit") ?? 4),
  });
  console.log(JSON.stringify({ arm, projectId: project.id, ...created, materialsHash }, null, 2));
} else {
  const registered = registerHostRun(project.id, {
    runtime: "claude-code", externalId: `hl-host-${arg("key") ?? "1"}`, idempotencyKey: `hl-host-${arg("key") ?? "1"}`,
    materials, parameters: { workUnits: 1, outputLanguage: "zh", limit: Number(arg("limit") ?? 4) },
  });
  const ledger = runLedger();
  const { validateRulePack } = await import("@testpilot/harness-testing/domain");
  const v = validateRulePack(pack);
  if (!v.ok) throw new Error("rule pack invalid");
  ledger.putRevision({ projectId: project.id, runId: registered.runId, name: `knowledge/rulepack/${v.pack.id}`, kind: "report",
    content: { name: `rulepack/${v.pack.id}`, roles: ["source", "stories", "cases", "gate"], trust: "user-provided", executable: false, rulePack: v.pack, rulePackHash: v.hash } }, { kind: "system", id: "web" });
  ledger.putRevision({ projectId: project.id, runId: registered.runId, name: "product/model-candidate", kind: "report", content: model }, { kind: "system", id: "web" });
  ledger.putRevision({ projectId: project.id, runId: registered.runId, name: "exploration/report", kind: "report", content: report }, { kind: "system", id: "explorer" });
  console.log(JSON.stringify({ arm, projectId: project.id, runId: registered.runId, created: registered.created, materialsHash }, null, 2));
}
