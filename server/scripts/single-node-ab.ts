/**
 * 单节点对照：同一条故事、同一份单元材料，只换契约措辞，看规划模型的产出差在哪。
 *
 * 两条臂的全流程对照回答「谁写得好」；这一条回答「提示词改了有没有用」——
 * 唯一的自变量是契约文本，材料、模型、温度、故事全一样。
 */
import { config } from "dotenv";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const projectId = arg("project")!, runId = arg("run")!, unitId = arg("unit")!;
const out = resolve(arg("out") ?? join(root, "docs/v3/evidence/hl-round2-2026-09-11/single-node"));
mkdirSync(out, { recursive: true });

const { unitMaterials, unitContract } = await import("../src/workUnits.js");
const { runLedger } = await import("../src/runService.js");
const { projectModelConnection } = await import("../src/modelProfiles.js");
const { TextCaseSchema, checkDesignEvidence, runGate } = await import("@testpilot/harness-testing/casegen");

const rows = runLedger().db.prepare("SELECT json FROM run_work_units WHERE runId=?").all(runId) as Array<{ json: string }>;
const unit = rows.map((r) => JSON.parse(r.json)).find((u) => u.unitId === unitId);
if (!unit) throw new Error(`unit_missing:${unitId}`);
const materials = unitMaterials(runId, projectId, { ...unit, runId });
const NEW = unitContract({ ...unit, runId });
const OLD = readFileSync(resolve(arg("old") ?? join(root, "docs/v3/evidence/hl-round2-2026-09-11/contract-v1.txt")), "utf8");

const conn = projectModelConnection(projectId, "planner");
async function ask(contract: string) {
  const body = {
    model: conn.model, temperature: 0, max_tokens: 8000, reasoning_effort: "none",
    messages: [
      { role: "system", content: "You are a senior test designer. Reply with JSON only: {\"cases\":[...]}. No prose, no markdown fence." },
      { role: "user", content: `${contract}\n\n<unit_materials>\n${JSON.stringify(materials, null, 1)}\n</unit_materials>` },
    ],
  };
  const res = await fetch(`${conn.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; error?: unknown };
  const text = json.choices?.[0]?.message?.content ?? "";
  return { text, finish: json.choices?.[0]?.finish_reason, error: json.error };
}
function parse(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { cases: [] as unknown[], parseError: "no_json" };
  try { return { ...(JSON.parse(m[0]) as { cases?: unknown[] }), parseError: undefined }; }
  catch (e) { return { cases: [] as unknown[], parseError: String(e).slice(0, 120) }; }
}
function profile(label: string, raw: unknown[]) {
  const parsed = raw.map((c) => TextCaseSchema.safeParse(c));
  const ok = parsed.flatMap((p) => (p.success ? [p.data] : []));
  const evidence = checkDesignEvidence(ok);
  const v2 = ["acRefs", "conditionRefs", "scenarioType", "design", "risk", "testData", "assertions", "readiness"] as const;
  const gate = runGate({ stories: [{ id: String(materials.story?.id), title: String(materials.story?.title), acceptance: materials.story?.acceptance ?? [] }], cases: ok, flows: [] } as never, { minNegativeRatio: 0.3 });
  return {
    label, produced: raw.length, schemaValid: ok.length,
    schemaErrors: parsed.flatMap((p) => (p.success ? [] : [p.error.issues[0]?.path.join("/") + ": " + p.error.issues[0]?.message])).slice(0, 6),
    withOracle: ok.filter((c) => c.oracle).length,
    withAssertionOracle: ok.filter((c) => (c.assertions ?? []).some((a) => a.oracle)).length,
    tierClaimedNoOracle: ok.filter((c) => c.tier < 3 && !c.oracle && !(c.assertions ?? []).some((a) => a.oracle)).length,
    v2Fields: Object.fromEntries(v2.map((k) => [k, ok.filter((c) => c[k] !== undefined).length])),
    evidenceErrors: evidence.length, evidenceCodes: [...new Set(evidence.map((e) => e.code))],
    gateScore: gate.score, gateWarns: gate.findings.filter((f) => f.severity === "warn").length,
  };
}
const results: Record<string, unknown> = { unitId, story: materials.story?.id, model: conn.model };
const samples = Number(arg("n") ?? 1);
for (const [label, contract] of [["v1", OLD], ["v2", NEW]] as const) {
  const runs: unknown[] = [];
  for (let i = 0; i < samples; i++) {
    const r = await ask(contract);
    const p = parse(r.text);
    writeFileSync(join(out, `${unitId.replace(/\W/g, "-")}-${label}-${i + 1}.json`), JSON.stringify({ contract, raw: r.text, parsed: p }, null, 2));
    const one = { ...profile(label, (p.cases ?? []) as unknown[]), sample: i + 1, finish: r.finish, parseError: p.parseError, error: r.error };
    runs.push(one);
    console.log(label, i + 1, JSON.stringify(one));
  }
  results[label] = runs;
}
writeFileSync(join(out, `${unitId.replace(/\W/g, "-")}-summary.json`), JSON.stringify(results, null, 2));
