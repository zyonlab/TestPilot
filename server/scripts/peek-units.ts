/** 只读：把某次运行的故事单元 scope 打出来（模块 / 功能 / 规则各几条）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const units = await import("../src/workUnits.js");
const [runId, project, node = "stories"] = process.argv.slice(2);
for (const u of units.unitStatus(runId!, project!, node as "stories").units) {
  const sc = u.scope as { kind: string; moduleIds?: string[]; featureIds?: string[]; ruleIds?: string[] };
  console.log(`${u.unitId}\t${u.status}\t${sc.kind}\tmodules=${(sc.moduleIds ?? []).length}\tfeatures=${(sc.featureIds ?? []).length}\t${u.reason ?? ""}`);
}
