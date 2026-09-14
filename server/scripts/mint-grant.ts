/** 给一个已注册 run 铸一个写入凭证（本地调试用；凭证只落到调用方的 stdout）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { adapterRunGrant } = await import("../src/runService.js");
const runId = process.argv[2];
if (!runId) throw new Error("runId required");
console.log("GRANT:" + adapterRunGrant(runId));
