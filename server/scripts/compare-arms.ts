/**
 * 两条规划臂的逐项对照（docs/v3/22 阶段 I）。
 *
 * 只读账本，按稳定 ID 算指标；不调模型、不改任何产物。指标分四组：
 * 拆分过程（单元数、上下文、重试）、故事、用例、门禁。
 */
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { validateRulePack, ProductModelSchema } = await import("@testpilot/harness-testing/domain");
const { runGate } = await import("@testpilot/harness-testing/casegen");

type Story = { id: string; title: string; role?: string; benefit?: string; acceptance: string[]; moduleIds?: string[]; featureRefs?: string[]; ruleRefs?: string[] };
type Case = { id: string; storyId: string; title: string; designMethod: string; priority?: string; tier: number; expected: string; steps: string[]; precondition: string[]; postSteps: string[]; sourceRefs: string[]; oracle?: { kind: string }; featureRefs?: string[]; ruleRefs?: string[] };

const projectId = process.argv[2]!;
const arms = process.argv.slice(3).map((a) => { const [name, runId] = a.split("="); return { name: name!, runId: runId! }; });
const l = runLedger();
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(resolve(import.meta.dirname, "../.."), "docs/v3/evidence/hl-mainnet-2026-09-11/compare"));
mkdirSync(out, { recursive: true });

const latest = (runId: string, name: string) => {
  const rows = l.listRevisions(projectId, runId).filter((r) => r.name === name);
  const last = rows.sort((a, b) => a.revision - b.revision).at(-1);
  return last ? l.readRevision(last.id, projectId).content : undefined;
};
const report: Record<string, unknown> = { at: new Date().toISOString(), projectId };

/**
 * 用例里用「」引的界面文案，能不能在冻结材料里逐字找到。
 *
 * 这一条查的是**编造**：一条断言引用了产品从没说过的话，执行时必然失败，而且失败得毫无道理。
 * 材料是两条臂共用的同一份，所以这个比例可以直接比。占位符 `${env.*}` 不算界面文案。
 */
const quoted = (t: string): string[] => [...t.matchAll(/[「『]([^」』]{2,60})[」』]/g)].map((m) => m[1]!).filter((q) => !q.includes("${"));
const materialText = ((): string => {
  const dir = join(resolve(import.meta.dirname, "../.."), "docs/v3/evidence/hl-mainnet-2026-09-11/explore");
  return ["exploration.md", "product-model.md"].map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n");
})();

for (const { name, runId } of arms) {
  const revs = l.listRevisions(projectId, runId);
  const storyUnits = revs.filter((r) => r.name.startsWith("units/stories/"));
  const caseUnits = revs.filter((r) => r.name.startsWith("units/cases/"));
  const stories = ((latest(runId, "validated/stories") as { stories?: Story[] } | undefined)?.stories) ?? [];
  const bundle = latest(runId, "validated/cases") as { stories?: Story[]; cases?: Case[] } | undefined;
  const cases = bundle?.cases ?? [];
  const model = ProductModelSchema.safeParse(latest(runId, "product/model-candidate"));
  const packRow = revs.find((r) => r.name.startsWith("knowledge/rulepack/"));
  const pack = packRow ? validateRulePack((l.readRevision(packRow.id, projectId).content as { rulePack?: unknown }).rulePack) : undefined;
  const rules = pack?.ok ? pack.pack.rules : [];
  const p0Rules = rules.filter((r) => r.riskFloor === "P0").map((r) => r.id);
  const features = model.success ? model.data.features.map((f) => f.id) : [];

  const refFeat = new Set([...stories.flatMap((s) => s.featureRefs ?? []), ...cases.flatMap((c) => c.featureRefs ?? [])]);
  const refRule = new Set([...stories.flatMap((s) => s.ruleRefs ?? []), ...cases.flatMap((c) => c.ruleRefs ?? [])]);
  const events = (l.db.prepare("SELECT json FROM workflow_events WHERE runId=? ORDER BY rowid").all(runId) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as { node: string; phase: string });
  const gate = cases.length ? runGate({ origin: "cmp", stories: (bundle?.stories ?? []) as never, flows: [], cases: cases as never }, { minNegativeRatio: 0.3 }) : undefined;
  const byRule = (list: string[]) => list.filter((id) => refRule.has(id)).length;

  report[name] = {
    runId,
    split: {
      storyUnits: storyUnits.length, caseUnits: caseUnits.length,
      unitNames: storyUnits.map((r) => r.name.split("/").pop()),
      caseUnitNames: caseUnits.map((r) => r.name.split("/").pop()),
    },
    stories: {
      count: stories.length,
      withRoleAndBenefit: stories.filter((s) => s.role && s.benefit).length,
      withAcceptance: stories.filter((s) => s.acceptance?.length).length,
      acceptanceTotal: stories.reduce((n, s) => n + (s.acceptance?.length ?? 0), 0),
      crossModule: stories.filter((s) => (s.moduleIds ?? []).length >= 2).length,
      distinctModules: new Set(stories.flatMap((s) => s.moduleIds ?? [])).size,
      withFeatureRefs: stories.filter((s) => (s.featureRefs ?? []).length).length,
      withRuleRefs: stories.filter((s) => (s.ruleRefs ?? []).length).length,
    },
    cases: {
      count: cases.length,
      perStory: stories.length ? Number((cases.length / stories.length).toFixed(2)) : 0,
      storiesCovered: new Set(cases.map((c) => c.storyId)).size,
      methods: cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.designMethod]: (m[c.designMethod] ?? 0) + 1 }), {}),
      priorities: cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.priority ?? "(none)"]: (m[c.priority ?? "(none)"] ?? 0) + 1 }), {}),
      tiers: cases.reduce<Record<string, number>>((m, c) => ({ ...m, [String(c.tier)]: (m[String(c.tier)] ?? 0) + 1 }), {}),
      oracleKinds: cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.oracle?.kind ?? "(none)"]: (m[c.oracle?.kind ?? "(none)"] ?? 0) + 1 }), {}),
      apiOracles: cases.filter((c) => c.oracle?.kind === "api").length,
      tierClaimedWithoutOracle: cases.filter((c) => c.tier <= 2 && !c.oracle).length,
      withSourceRefs: cases.filter((c) => c.sourceRefs?.length).length,
      withPostSteps: cases.filter((c) => Array.isArray(c.postSteps)).length,
      withFeatureRefs: cases.filter((c) => (c.featureRefs ?? []).length).length,
      withRuleRefs: cases.filter((c) => (c.ruleRefs ?? []).length).length,
      avgSteps: cases.length ? Number((cases.reduce((n, c) => n + c.steps.length, 0) / cases.length).toFixed(2)) : 0,
      requiresFixture: cases.filter((c) => c.precondition.some((p) => /requires-fixture/.test(p))).length,
    },
    quotedUiText: (() => {
      const all = cases.flatMap((c) => quoted(`${c.title} ${c.expected} ${c.steps.join(" ")} ${c.precondition.join(" ")}`).map((q) => ({ caseId: c.id, q })));
      const missing = all.filter(({ q }) => !materialText.includes(q));
      return { quotes: all.length, distinct: new Set(all.map((x) => x.q)).size, notInMaterial: missing.length, examples: [...new Set(missing.map((m) => `${m.caseId}:${m.q}`))].slice(0, 8) };
    })(),
    coverage: {
      featuresInModel: features.length,
      featuresReferenced: features.filter((f) => refFeat.has(f)).length,
      rulesInPack: rules.length,
      rulesReferenced: byRule(rules.map((r) => r.id)),
      p0Rules: p0Rules.length,
      p0RulesReferenced: byRule(p0Rules),
      p0RulesMissing: p0Rules.filter((id) => !refRule.has(id)),
    },
    gate: gate ? { score: gate.score, findings: gate.findings.length, bySeverity: gate.findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }), {}), byRule: gate.findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.rule]: (m[f.rule] ?? 0) + 1 }), {}), negativeRatio: gate.stats.negativeRatio } : undefined,
    events: { total: events.length, blocked: events.filter((e) => e.phase === "blocked").length, failed: events.filter((e) => e.phase === "failed").length, nodes: [...new Set(events.map((e) => e.node))] },
  };
}
writeFileSync(join(out, "compare.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
