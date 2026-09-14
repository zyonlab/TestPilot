/** 用复核后的用例头版重算门禁分（只读）。 */
import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const [projectId, runId, out] = process.argv.slice(2);
const { reviewRevisions } = await import("../src/approvedRuns.js");
const { runLedger } = await import("../src/runService.js");
const { runGate } = await import("@testpilot/harness-testing/casegen");
const stories = runLedger().listRevisions(projectId!, runId!).filter((r) => r.name === "validated/stories").sort((a, b) => a.revision - b.revision).at(-1)!;
const bundle = { ...(runLedger().readRevision(stories.id, projectId!).content as Record<string, unknown>), cases: reviewRevisions(runId!, projectId!).map((c) => c.content), flows: [] };
const r = runGate(bundle as never, { minNegativeRatio: 0.3 });
const by: Record<string, number> = {}; for (const f of r.findings) by[`${f.severity}:${f.rule}`] = (by[`${f.severity}:${f.rule}`] ?? 0) + 1;
console.log(JSON.stringify({ score: r.score, stats: r.stats, byRule: by, flagged: r.scoreBasis.flagged }, null, 1));
if (out) writeFileSync(resolve(out), JSON.stringify(bundle, null, 2));
