/** 只读：按 revision id 导出内容。 */
import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { runLedger } = await import("../src/runService.js");
const [revId, projectId, out] = process.argv.slice(2);
writeFileSync(out!, JSON.stringify(runLedger().readRevision(revId!, projectId!).content, null, 1));
console.log("written", out);
