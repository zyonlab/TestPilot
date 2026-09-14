/** 给一个已注册 run 铸一张写入凭证并落到文件（本地调试；文件权限 600）。 */
import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { adapterRunGrant } = await import("../src/runService.js");
const [runId, projectId, out] = process.argv.slice(2);
if (!runId || !projectId || !out) throw new Error("用法: mint-grant2 <runId> <projectId> <outFile>");
writeFileSync(out, JSON.stringify({ runId, projectId, token: adapterRunGrant(runId, projectId) }), { mode: 0o600 });
console.log("written", out);
