/** 手动触发一次单元合并并打印完整校验结果（调试用）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { mergeUnits } = await import("../src/workUnits.js");
const [runId, projectId, node] = process.argv.slice(2);
try { console.log(JSON.stringify(mergeUnits(runId!, projectId!, (node ?? "cases") as "cases"), null, 1).slice(0, 3000)); }
catch (e) { console.log("THROW:", (e as Error).message); }
