/** 取一条已注册 run 的写入令牌（本地联调用；不要落进报告或日志）。 */
import { config } from "dotenv";
import { join, resolve } from "node:path";
config({ path: join(resolve(import.meta.dirname, "../.."), "server/.env"), quiet: true } as never);
const { adapterRunGrant } = await import("../src/runService.js");
process.stdout.write(adapterRunGrant(process.argv[3]!, process.argv[2]!));
