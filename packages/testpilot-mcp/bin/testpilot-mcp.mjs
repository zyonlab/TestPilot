#!/usr/bin/env node
/**
 * stdio 入口。
 *
 * 这个仓库的包是**以 TypeScript 源码**被消费的（`exports` 直指 `src/*.ts`，没有构建产物），
 * 所以入口先挂上 tsx 再进 `server.ts`。MCP 客户端只要能执行这个文件就行，不必知道里面是 TS，
 * 也不必替我们拼 `--import tsx` 这样的命令行。
 *
 * 用 `tsx/esm/api` 的 `register()`，不用 `node:module` 的：后者会走已废弃的 `--loader`
 * 路径，tsx 会当场拒绝（"tsx must be loaded with --import instead of --loader"）。
 *
 * 裸说明符从**本文件**的位置解析，不从 cwd——MCP 客户端会把子进程的 cwd 设成它自己的
 * workspace，那里没有这个包的 node_modules。
 */
import { register } from "tsx/esm/api";
import { loadModelEnv } from "./model-env.mjs";

if (process.env.TP_MODEL_ENV_FILE) loadModelEnv(process.env.TP_MODEL_ENV_FILE);

register();
await import(new URL("../src/server.ts", import.meta.url).href);
