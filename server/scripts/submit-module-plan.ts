/**
 * 把一份模块树提案送进真正的 `modules` 节点，然后按参照臂给它打分。
 *
 * 和 `plan-modules-ab.ts` 的区别：那个脚本只调模型、把 JSON 落到磁盘，机检是离线跑的
 * （`check-module-plan.ts`）。这个脚本走的是**服务端节点**——注册 run、过 HTTP、由
 * `moduleStage.writeModulePlan` 判、由人冻结。离线机检和节点跑出来的结论必须一致；
 * 不一致说明节点和检查两边有一边没落到位，那才是这个脚本要抓的东西。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!;
const planFile = resolve(arg("plan")!);
const label = arg("label") ?? "modules-node";
const base = arg("api") ?? "http://127.0.0.1:5301";
const api = `${base}/api/projects/${projectId}/workflow-runs`;

const plan = JSON.parse(readFileSync(planFile, "utf8")) as { parsed?: Record<string, unknown> } & Record<string, unknown>;
const proposal = (plan.parsed ?? plan) as { modules?: unknown[]; stories?: unknown[]; outOfScope?: unknown[] };
const materials = ["domain-perp-zh.md", "observed-zh.md"].map((name) =>
  ({ name, text: readFileSync(join(root, "fixtures/hyperliquid-mainnet/materials", name), "utf8") }));

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json: json as Record<string, any> };
}

const key = `${label}-${Date.now()}`;
const reg = await call("/register", { runtime: "codex", externalId: key, idempotencyKey: key, materials,
  parameters: { workUnits: 1, stageControlVersion: 1 } });
if (reg.status !== 201) { console.error("register failed", reg.status, JSON.stringify(reg.json).slice(0, 400)); process.exit(1); }
const runId: string = reg.json.runId, token: string = reg.json.writeToken;

// 节点要先被 begin 过：`stageControlVersion: 1` 的 run 不许跳过这一步。
const started = await call(`/${runId}/begin-stage`, { node: "modules" }, token);

const written = await call(`/${runId}/stages/modules`, { modules: proposal.modules ?? [], outOfScope: proposal.outOfScope ?? [] }, token);
const frozen = written.json?.status === "validated" ? await call(`/${runId}/modules/freeze`, {}) : undefined;
const state = await call(`/${runId}/stages/modules/state`, {}, token);

const out = { runId, planFile, begin: started?.json?.status ?? started?.status, write: written.json, freeze: frozen?.json, state: state.json };
writeFileSync(join(root, "docs/v3/evidence/module-plan-2026-09-11", `node-${label}.json`), JSON.stringify(out, null, 2));
const findings = (written.json?.findings ?? []) as Array<{ code: string; severity: string }>;
const by = (s: string) => findings.filter((f) => f.severity === s).length;
console.log(JSON.stringify({ runId, http: written.status, status: written.json?.status,
  modules: (proposal.modules ?? []).length, errors: by("error"), warn: by("warn"), info: by("info"),
  codes: [...new Set(findings.map((f) => f.code))], frozen: frozen?.json?.frozen ?? false, openFindings: frozen?.json?.openFindings }, null, 1));
