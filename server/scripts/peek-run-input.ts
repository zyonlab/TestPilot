import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
const run: any = l.outputs.getRun(runId!);
console.log("status:", run?.status);
console.log("detail.parameters:", JSON.stringify(run?.detail?.parameters ?? run?.detail, null, 1).slice(0, 900));
const reg = l.db.prepare("SELECT bindingJson FROM wf_run_registrations WHERE runId=?").get(runId!) as any;
const b = JSON.parse(reg.bindingJson);
console.log("binding keys:", Object.keys(b).join(", "));
console.log("materialRevisions:", b.materialRevisions?.length);
for (const id of b.materialRevisions ?? []) {
  const r = l.readRevision(id, projectId!);
  console.log(`  ${r.revision.name}  ${String(r.content).length} 字符`);
}
console.log("skillVersion:", b.skillVersion, "· contextPolicy:", JSON.stringify(b.contextPolicy));
const names = l.listRevisions(projectId!, runId!).map((r: any) => r.name);
console.log("修订名（去重）:", [...new Set(names)].join(", ").slice(0, 700));
