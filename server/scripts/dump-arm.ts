/** 把一条臂的最终物料导出到证据目录（只读）。 */
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const [projectId, runId, name] = process.argv.slice(2);
const l = runLedger();
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(resolve(import.meta.dirname, "../.."), "docs/v3/evidence/hl-mainnet-2026-09-11/arms"), name!);
mkdirSync(out, { recursive: true });
const revs = l.listRevisions(projectId!, runId!);
const pick = (n: string) => { const r = revs.filter((x) => x.name === n).sort((a, b) => a.revision - b.revision).at(-1); return r ? l.readRevision(r.id, projectId!).content : undefined; };
for (const [file, content] of [["stories.json", pick("validated/stories")], ["cases.json", pick("validated/cases")], ["gate.json", pick("validated/gate")], ["finalize.json", pick("validated/finalize")]] as const)
  if (content !== undefined) writeFileSync(join(out, file), JSON.stringify(content, null, 2));
const units = revs.filter((r) => r.name.startsWith("units/")).map((r) => ({ name: r.name, revision: r.revision, contentHash: r.contentHash, createdAt: r.createdAt }));
const events = (l.db.prepare("SELECT json FROM workflow_events WHERE runId=? ORDER BY rowid").all(runId) as Array<{ json: string }>).map((r) => JSON.parse(r.json));
writeFileSync(join(out, "units.json"), JSON.stringify(units, null, 2));
writeFileSync(join(out, "events.json"), JSON.stringify(events, null, 2));
const wu = l.db.prepare("SELECT json FROM run_work_units WHERE runId=?").all(runId) as Array<{ json: string }>;
writeFileSync(join(out, "work-units.json"), JSON.stringify(wu.map((r) => JSON.parse(r.json)), null, 2));
console.log(JSON.stringify({ name, runId, revisions: revs.length, units: units.length, workUnits: wu.length, out }));
