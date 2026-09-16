/**
 * judge 判据的真实评测：拿 `fixtures/judge-golden` 的每一条，走执行器的完整路径
 * （`executeRun` → 浏览器打开本地页面 → 采样 → 聚合），和标准答案比。
 *
 * 量两件事：
 * - **准不准**：判决与 golden 一致的比例；判成「没量到」的单独计，不算对也不算错。
 * - **稳不稳**：同一条跑 `--repeat` 遍，判决是否每遍一样；以及采样之间意见不一的比例。
 *
 * 需要 `--real`：会调执行模型（server/.env 里的配置），每条每遍 `samples` 次。
 * 用法：pnpm exec tsx scripts/eval-judge.ts --real [--repeat 2] [--only G-01,G-02] [--out <dir>]
 */
import { config } from "dotenv";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeRun, MachineOracleSchema, releaseRunSession } from "@testpilot/harness-testing/exec";

const root = resolve(import.meta.dirname, "../..");
config({ path: join(root, "server/.env"), quiet: true } as never);
if (!process.argv.includes("--real")) throw new Error("--real required：这个脚本会调执行模型");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const repeat = Number(arg("--repeat") ?? 2);
const only = arg("--only")?.split(",");
const outDir = resolve(arg("--out") ?? join(root, "server/.data/eval-judge"));

const dir = join(root, "fixtures/judge-golden");
const golden = JSON.parse(readFileSync(join(dir, "golden.json"), "utf8")) as {
  version: string; items: Array<{ id: string; page: string; what: string; oracle: unknown; expected: "pass" | "fail" }>;
};
const items = golden.items.filter((i) => !only || only.includes(i.id));

// 本地静态页面：只服务 golden 目录下的 pages/。
const server = createServer((req, res) => {
  const name = (req.url ?? "/").replace(/^\/+/, "").split("?")[0]!;
  if (!/^[a-z0-9-]+\.html$/.test(name)) { res.writeHead(404).end(); return; }
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(dir, "pages", name)));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Row = { id: string; round: number; expected: string; verdict: string; detail: string; judge?: unknown; ms: number; modelCalls: number; infra: boolean };
const rows: Row[] = [];
const sessionKey = `eval-judge-${Date.now()}`;
try {
  for (let round = 1; round <= repeat; round++) {
    for (const item of items) {
      const oracle = MachineOracleSchema.parse(item.oracle);
      const started = Date.now();
      const result = await executeRun(`${base}/${item.page}`, [], item.what, { oracle, sessionKey, cacheId: `judge-${item.id}` });
      const check = result.oracle[0];
      const verdict = result.infraError ? "infra" : check?.status ?? result.status;
      rows.push({ id: item.id, round, expected: item.expected, verdict, detail: check?.detail ?? result.failureReason ?? "", judge: check?.judge,
        ms: Date.now() - started, modelCalls: (result as { modelRequests?: unknown[] }).modelRequests?.length ?? 0, infra: !!result.infraError });
      console.log(`[${round}] ${item.id} 应 ${item.expected} → ${verdict}  ${(check?.detail ?? result.failureReason ?? "").slice(0, 110)}`);
    }
  }
} finally {
  await releaseRunSession(sessionKey).catch(() => false);
  server.close();
}

// 汇总
const decided = rows.filter((r) => r.verdict === "pass" || r.verdict === "fail");
const correct = decided.filter((r) => r.verdict === r.expected);
const byItem = new Map<string, Row[]>();
for (const r of rows) byItem.set(r.id, [...(byItem.get(r.id) ?? []), r]);
const stable = [...byItem.values()].filter((rs) => new Set(rs.map((r) => r.verdict)).size === 1);
const splits = rows.filter((r) => (r.judge as { split?: boolean } | undefined)?.split);
const summary = {
  golden: golden.version,
  items: items.length,
  repeat,
  runs: rows.length,
  decided: decided.length,
  unobservable: rows.filter((r) => r.verdict === "unobservable").length,
  infra: rows.filter((r) => r.infra).length,
  accuracy: decided.length ? +(correct.length / decided.length).toFixed(3) : null,
  wrong: decided.filter((r) => r.verdict !== r.expected).map((r) => `${r.id}#${r.round}`),
  stableItems: `${stable.length}/${byItem.size}`,
  unstable: [...byItem.entries()].filter(([, rs]) => new Set(rs.map((r) => r.verdict)).size > 1).map(([id, rs]) => `${id}: ${rs.map((r) => r.verdict).join("/")}`),
  splitRuns: splits.map((r) => `${r.id}#${r.round}`),
  medianMs: [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0,
  modelCalls: rows.reduce((a, r) => a + r.modelCalls, 0),
};
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `eval-judge-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));
console.log("\n== 汇总");
console.log(JSON.stringify(summary, null, 1));
console.log(`结果：${file}`);
