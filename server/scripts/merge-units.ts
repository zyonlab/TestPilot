/** 只读诊断 + 手动合并：单元都写完了但 validated/<node> 没出来时，把合并的真实报错打出来。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const units = await import("../src/workUnits.js");
const [runId, projectId, node = "cases"] = process.argv.slice(2);
try {
  console.log(JSON.stringify(units.mergeUnits(runId!, projectId!, node as "cases"), null, 1).slice(0, 2000));
} catch (e) {
  console.log("merge threw:", (e as Error).message);
}
