/** 这条 run 的定位提示表长什么样（只读）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const { locatorHints } = await import("@testpilot/harness-testing/exec");
const [projectId, runId] = process.argv.slice(2);
const rev = runLedger().listRevisions(projectId!, runId!).filter((r) => r.name === "exploration/report").sort((a, b) => a.revision - b.revision).at(-1);
if (!rev) { console.log("no exploration report"); process.exit(0); }
const hints = locatorHints(runLedger().readRevision(rev.id, projectId!).content as never);
console.log(hints.length, "条");
for (const h of hints) console.log(" ", h.featureId?.padEnd(22), h.label.padEnd(24), h.selector.slice(0, 60));
