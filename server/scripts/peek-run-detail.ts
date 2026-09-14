/** 只读：一次运行记录里的 error / spend / 预算，外加最后几条阶段事件。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { outputStore } = await import("../src/graphs.js");
const [runId] = process.argv.slice(2);
const row = outputStore.getRun(runId!) as { status?: string; detail?: Record<string, unknown> } | undefined;
const d = (row?.detail ?? {}) as Record<string, unknown>;
console.log("status:", row?.status);
for (const k of ["error", "spend", "budget", "stoppedBecause", "penguin"]) if (d[k] !== undefined) console.log(k + ":", JSON.stringify(d[k]).slice(0, 400));
