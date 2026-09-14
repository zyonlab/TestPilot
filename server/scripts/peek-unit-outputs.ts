import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const l = runLedger();
const [runId, projectId] = process.argv.slice(2);
for (const r of l.listRevisions(projectId!, runId!)) {
  if (!/^units\/|^validated\//.test(r.name)) continue;
  const c: any = l.readRevision(r.id, projectId!).content;
  const n = (c.stories ?? c.cases ?? []).length;
  console.log(`${r.name}@${r.revision}  ${n} 条`);
}
