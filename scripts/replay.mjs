#!/usr/bin/env node
/**
 * 对仓库里冻结的运行重打分，和 expected.json 逐位比。
 *
 * `benchmark/<cap>/replay/<run>/{cases.json,meta.json}` + `expected.json`。
 * 用法：node scripts/replay.mjs            任何一处对不上退出 1
 *      node scripts/replay.mjs --write    把当前分写成 expected（宣告「我知道为什么变了」）
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

const req = createRequire(pathToFileURL(path.join(ROOT, "packages/testpilot-mcp/package.json")));
const { register } = await import(pathToFileURL(req.resolve("tsx/esm/api")).href);
register();
const { scoreRun } = await import(pathToFileURL(path.join(ROOT, "packages/testpilot-mcp/src/score.ts")).href);

const KEYS = ["coverage", "heldOutCoverage", "cases"];
let problems = 0;
let checked = 0;
for (const cap of readdirSync(path.join(ROOT, "benchmark"))) {
  const replayDir = path.join(ROOT, "benchmark", cap, "replay");
  const gold = path.join(ROOT, "benchmark", cap, "gold.json");
  if (!existsSync(replayDir) || !existsSync(gold)) continue;
  for (const run of readdirSync(replayDir)) {
    const dir = path.join(replayDir, run);
    if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, "meta.json"))) continue;
    const entry = await scoreRun({ runId: dir, goldPath: gold });
    const got = Object.fromEntries(KEYS.map((k) => [k, entry[k]]));
    const expectedPath = path.join(dir, "expected.json");
    if (WRITE) {
      writeFileSync(expectedPath, JSON.stringify({ goldHash: entry.goldHash, ...got }, null, 2) + "\n");
      console.log(`${cap}/${run}: expected written`, got);
      continue;
    }
    if (!existsSync(expectedPath)) {
      console.error(`${cap}/${run}: 没有 expected.json——先跑 --write`);
      problems += 1;
      continue;
    }
    const exp = JSON.parse(readFileSync(expectedPath, "utf8"));
    checked += 1;
    if (exp.goldHash !== entry.goldHash) {
      console.error(`${cap}/${run}: gold.json 变了（${exp.goldHash} → ${entry.goldHash}）——新谱系，expected 作废，确认后 --write`);
      problems += 1;
    }
    for (const k of KEYS)
      if (exp[k] !== got[k]) {
        console.error(`${cap}/${run}: ${k} ${exp[k]} → ${got[k]}`);
        problems += 1;
      }
  }
}
if (!WRITE) {
  if (problems) {
    console.error(`replay: ${problems} 处对不上`);
    process.exit(1);
  }
  console.log(`replay: ${checked} 次冻结运行的分与 expected 逐位相同`);
}
