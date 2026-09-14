import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { adapterRunGrant, registerHostRun, runLedger } from "../runService.js";
import { dataPath } from "../datadir.js";
import type { HostRuntime } from "@testpilot/harness-core/model-profiles";

export interface GenerationMessageInput {
  materialsDir: string; outDir: string; limit?: number; ablate?: string[];
  generationMode?: "skill" | "pipeline";
  /** 单元循环（docs/v3/22）：整份写入被拒，规划器逐个领单元。 */
  workUnits?: boolean;
}

/**
 * 单元循环的任务话术。
 *
 * 和整份话术的区别只有一处，但那一处是全部：**这里没有「写出全部故事」这个动作**。
 * 拆分由服务端按产品模型做，规划器一次只看一个单元的功能、规则与观察，写完一个再领下一个；
 * 合并也由服务端做。上下文因此不随产品规模增长，而随单元大小固定。
 */
export function unitGenerationMessage(input: GenerationMessageInput): string {
  const runId = basename(input.outDir);
  return [
    "Use TestPilot skill mode with WORK UNITS. You are the planning model, but you never write a whole bundle: the server splits the work and merges it.",
    `This run is already registered: runId=${JSON.stringify(runId)}. Use that exact ID in every tool.`,
    "Before each node call begin_stage (node=modules, then instructions, then stories, then cases, then gate, then finalize). If it returns paused/cancelled/failed, STOP this turn immediately.",
    "Call load_run_instructions once and read the returned skills and domain references.",
    /**
     * 产品规划这一步此前**不在这份清单里**，于是 Web 臂从来没跑过它（2026-09-12 实测：
     * 一次完整运行里 source → instructions → stories，账本上没有任何 `modules` 回执，
     * 故事按的是规则包里现成的模块树）。工具一直都在（`plan_modules` / `module_plan_state`），
     * 缺的只是这一句。
     */
    "For node=modules: begin_stage returns `sections` — the exact list of citable material section ids. Every module's evidence must come from THAT list, copied verbatim; an id outside it names a section that does not exist. Each module also claims the product-model features it covers (featureIds): when you give modules new ids, the features still point at the OLD tree, and anything no module claims never reaches the story units at all — its rules and observations are simply absent. Then call plan_modules({runId, content}) with this product's module tree, then STOP that node — a human freezes the tree in TestPilot Web before stories can be split along it, and you cannot freeze it yourself. If module_plan_state says a tree is already frozen, skip planning and use it unchanged.",
    "Then loop, for node=stories and afterwards for node=cases:",
    "  1. claim_unit({runId, node}) — it returns one unit: its scope, a ContextManifest, the exact features/rules/observations/conflicts in scope, and a `contract` telling you what to write.",
    "  2. If unit is null, the node is finished; move on (stories -> cases -> gate_run -> finalize_run).",
    "  3. Call retrieve_spec({runId, query, budgetTokens}) with a query built from THIS unit's feature names and rule statements. Cite the returned chunk ids in sourceRefs.",
    "  4. Reason only about this unit, then call write_unit({runId, unitId, content}) with just that unit's stories or cases.",
    "  5. A blocked result lists errors with jsonPointer and repairScope: fix only that unit and call write_unit again. Never widen the scope to make an error go away.",
    "Rules that hold for every unit: keep ids stable and globally unique; never invent a feature or rule id that is not in the unit materials; a rule with riskFloor P0 forces priority P0 even when a fixture is missing; a hypothesis claim may only become an open question, never an acceptance criterion; expected results come from the rules, not from what the page happened to show.",
    ...(input.limit ? [`Aim for at most ${input.limit} stories per module unit.`] : []),
    "Do not call write_stories or write_cases: with work units they are refused. Finish at waiting_review and report the unit counts.",
  ].join("\n");
}
export function generationMessage(input: GenerationMessageInput) {
  if (input.generationMode === "pipeline") return [
    "Explicit A comparison mode: use testpilot-generate and call run_pipeline exactly once.",
    "- `stage` = `g1`", `- \`materialsDir\` = ${JSON.stringify(input.materialsDir)}`, `- \`outDir\` = ${JSON.stringify(input.outDir)}`,
    ...(input.limit ? [`- \`limit\` = ${input.limit}`] : []),
    ...(input.ablate?.length ? [`- \`ablate\` = ${JSON.stringify(input.ablate)} (required, pass exactly)`] : []),
    "This mode delegates generation to the configured internal planner. Report that mechanism explicitly.",
  ].join("\n");
  if (input.workUnits) return unitGenerationMessage(input);
  return [
    "Use TestPilot skill mode. You are the planning model: reason about the supplied materials and write the stories and cases yourself.",
    `This run is already registered: runId=${JSON.stringify(basename(input.outDir))}. Use that exact ID in every tool.`,
    "Before planning EACH stage call begin_stage with node=modules/instructions/stories/cases/gate/finalize. If it returns paused/cancelled/failed, STOP this turn immediately without executing or planning later stages. Never resume yourself.",
    "Call load_run_instructions, then retrieve_spec with runId, query and budgetTokens. Read the returned skills and domain references.",
    "For node=modules: begin_stage returns `sections` — the exact list of citable material section ids; cite only from it, verbatim. Each module claims the features it covers (featureIds) — unclaimed features never reach the story units. Call plan_modules({runId, content}) with this product's module tree and then STOP that node — a human freezes it in TestPilot Web; you cannot freeze it yourself.",
    "Then call write_stories, write_cases, gate_run and finalize_run in order. Correct concrete validation findings before continuing.",
    "The cases must preserve the stored stories exactly and cite chunk IDs returned by retrieve_spec for this run.",
    ...(input.limit ? [`Generate at most ${input.limit} stories.`] : []),
    "Return the finalized run ID, story count, case count, gate score and waiting_review status. Human review happens in TestPilot Web.",
  ].join("\n");
}
/** Native adapters inherit their host planner; only the executor comes from TestPilot. */
export function prepareSkillLaunch(input: { runId: string; scopeProjectId?: string; materialsDir: string; runtime: HostRuntime; limit?: number; ablate?: string[] }) {
  const projectId = input.scopeProjectId;
  if (!projectId) throw new Error("skill_run_project_required");
  if (input.ablate?.length) throw new Error("skill_ablation_requires_registered_experiment");
  if (!runLedger().registration(input.runId, projectId)) {
    const materials: Array<{ name: string; text: string }> = [];
    const walk = (dir: string, prefix = "") => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (/\.(md|txt)$/.test(e.name)) materials.push({ name: `${prefix}${e.name}`, text: readFileSync(join(dir, e.name), "utf8") });
    } };
    walk(input.materialsDir);
    registerHostRun(projectId, { externalId: input.runId, idempotencyKey: input.runId, runtime: input.runtime, materials,
      parameters: input.limit ? { limit: input.limit } : {} }, input.runId);
  }
  const grant = { runId: input.runId, projectId, token: adapterRunGrant(input.runId, projectId) };
  const dir = dataPath("private-run-grants"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${input.runId}.json`);
  writeFileSync(path, JSON.stringify(grant), { mode: 0o600 });
  return { TP_RUN_GRANT_FILE: path, TP_GENERATION_MODE: "skill" };
}
