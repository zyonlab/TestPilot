/**
 * 包的入口。
 *
 * 契约（`contracts.ts`）排在最前面：Phase 1 的 B 路与 C 路引的就是它，
 * 而它们不该为了拿一个 zod schema 而 import 到 `server.ts`——那会当场起一个 MCP server。
 */
export * from "./contracts.js";
export * from "./pipeline.js";
export * from "./runs.js";
export * from "./retrieve.js";
export * from "./score.js";
export * from "./environment.js";
export * from "./exec.js";
export * from "./calibrate.js";
