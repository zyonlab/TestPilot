/**
 * 读一次运行留下的东西。
 *
 * 所有工具都从这里拿 `RunMeta` 与用例，理由是拒收规则只有在**一处**实现才成立：
 * 有两处，就会有一处忘了检查，而那一处产出的分数看起来和别的分数一模一样。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CandidateCase } from "@testpilot/harness-core";
import { DecisionSchema, Held, RunMetaSchema, missingBinding, type Decision, type RunMeta } from "./contracts.js";

/**
 * Where runs live when a tool is not told.
 *
 * The MCP server's `cwd` is this package (the gateway writes it that way), while runs are
 * written under `<workspace>/runs/` — a bare relative `runs` would point at a directory
 * that never has anything in it, and every `score_run` from a skill would come back
 * "run not found". The gateway therefore sets `TP_RUNS_DIR` in the server's env;
 * `runsDir` on a call still wins over it.
 */
export const DEFAULT_RUNS_DIR = process.env.TP_RUNS_DIR || "runs";

/**
 * 从 runId 找到目录。
 *
 * 三条路，按可靠性排：给的就是一个路径 → `runsDir/<runId>` → 在 `runsDir` 底下找
 * `meta.json` 里 runId 对得上的那个目录。第三条不是多余的：`run_pipeline` 的 `outDir`
 * 由调用方起名，它不必等于运行自己的 id（Phase 0 的产物就是这样：目录叫
 * `20260902T161435`，里面的 runId 是 `20260902T161440`）。
 */
export function resolveRunDir(runId: string, runsDir: string = DEFAULT_RUNS_DIR): string {
  if (isAbsolute(runId) && existsSync(runId)) return runId;
  const root = resolve(runsDir);
  const direct = join(root, runId);
  if (existsSync(direct)) return direct;
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const meta = join(dir, "meta.json");
      if (!existsSync(meta)) continue;
      try {
        if ((JSON.parse(readFileSync(meta, "utf8")) as { runId?: string }).runId === runId) return dir;
      } catch {
        // 一份读不动的 meta.json 不该挡住对别的目录的查找。
      }
    }
  }
  throw new Error(`no such run: ${runId} (looked in ${root})`);
}

/**
 * 读 `meta.json`，**缺一项就不打分**。
 *
 * 契约 §2 的拒收规则落在这一行。它不给默认值、不猜、不「尽力而为」：一次没有来源印记的
 * 运行**不是**一次可以打分的运行——给它一个分数，那个分数会进 scoreboard，
 * 而 scoreboard 上的每一行都被当作可比的。P3 的全部意思就是这一句。
 */
export function readMeta(runDir: string): RunMeta {
  const path = join(runDir, "meta.json");
  if (!existsSync(path))
    throw new Held(
      "binding",
      `${runDir} has no meta.json — this run carries no provenance (skillVersion / promptsDigest / model / materialsHash), ` +
        `so it cannot be scored. Re-run it with run_pipeline, which writes meta.json.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not readable JSON: ${(e as Error).message}`);
  }
  const missing = missingBinding(raw);
  if (missing.length)
    throw new Held(
      "binding",
      `${path} is missing or malformed on: ${missing.join(", ")} — refusing to score. ` +
        `A scoreboard entry without a complete binding is indistinguishable from a comparable one.`,
    );
  return RunMetaSchema.parse(raw);
}

/** `cases.json` → 打分器要的形状。缺文件或空集合都当场说清是哪一种。 */
export function readCases(runDir: string): CandidateCase[] {
  const path = join(runDir, "cases.json");
  if (!existsSync(path)) throw new Error(`${runDir} has no cases.json — nothing to score`);
  const bundle = JSON.parse(readFileSync(path, "utf8")) as {
    cases?: Array<{ id?: string; title?: string; steps?: string[]; expected?: string }>;
  };
  const cases = (bundle.cases ?? []).map((c) => ({
    id: c.id,
    title: c.title ?? "",
    steps: c.steps ?? [],
    expected: c.expected ?? "",
  }));
  if (!cases.length) throw new Error(`${path} holds no cases — this run produced nothing to score`);
  return cases;
}

/** 用例的完整形状（步骤之外还有 precondition / postSteps / oracle），执行侧要用。 */
export interface FullCase {
  id: string;
  title: string;
  steps: string[];
  expected: string;
  precondition?: string[];
  postSteps?: string[];
  oracle?: { kind: string; value?: string };
}

export function readFullCases(runDir: string): FullCase[] {
  const path = join(runDir, "cases.json");
  if (!existsSync(path)) throw new Error(`${runDir} has no cases.json — nothing to execute`);
  const bundle = JSON.parse(readFileSync(path, "utf8")) as { cases?: FullCase[] };
  return (bundle.cases ?? []).map((c) => ({ ...c, steps: c.steps ?? [], expected: c.expected ?? "" }));
}

/**
 * 复核决定。**没有就是空数组，不是错误。**
 *
 * 「还没有人决定」是这条流水线上一个完全正常的状态——第一次跑完、还没进审计台的每一次
 * 运行都在这个状态里。把它当成错误，会让 skill 在最常见的那条路上收到一个异常。
 */
export function readDecisions(runDir: string): Decision[] {
  const path = join(runDir, "decisions.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // 两种形状都收：裸数组，或者 `{ decisions: [...] }`（C 路写回时可能带壳）。
    const list = Array.isArray(raw) ? raw : ((raw as { decisions?: unknown[] })?.decisions ?? []);
    // 只回形状合法的条目：一条 `decidedByKind` 不是 human 的「决定」不是决定，丢掉。
    // 这是「批准永远是人」在读端的落点；写端由 protect-decisions hook 与审计台路由把住。
    return list.flatMap((d) => {
      const parsed = DecisionSchema.safeParse(d);
      return parsed.success ? [parsed.data] : [];
    });
  } catch (e) {
    throw new Error(`${path} exists but is not readable JSON: ${(e as Error).message}`);
  }
}
