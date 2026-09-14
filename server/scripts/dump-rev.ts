/** 按名字导出一个 run 的某个 revision 内容（只读）。 */
import { config } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const [projectId, runId, name, out] = process.argv.slice(2);
const l = runLedger();
const rows = l.listRevisions(projectId!, runId!).filter((r) => r.name === name);
const last = rows.sort((a, b) => a.revision - b.revision).at(-1);
if (!last) throw new Error(`revision_missing:${name}`);
const c = l.readRevision(last.id, projectId!).content;
if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), typeof c === "string" ? c : JSON.stringify(c, null, 2)); console.log("wrote", out); }
else console.log(typeof c === "string" ? c.slice(0, 2000) : JSON.stringify(c, null, 1).slice(0, 2500));
