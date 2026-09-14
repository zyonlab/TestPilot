/**
 * 把用例真的跑到被测对象上：`drive_sut`（一条）与 `mutate_and_detect`（一轮变异）。
 *
 * 这两个是整套工具里唯一**会碰外面世界**的。它们包的是 `harness-testing/exec` 的
 * `executeRun`——那一层已经知道怎么起浏览器、怎么把 `${env.*}` / `${secret.*}` 解开、
 * 怎么把「模型/网络挂了」和「产品真的错了」分开（`failKind: "infra"`）。这里不重写，
 * 只做三件事：找到用例、把结果投影成 JSON-RPC 送得出去的形状、把错误说人话。
 *
 * 生成与判定分 workspace（架构 §3）：这两个工具**不写** `benchmark/`，一个字都不写。
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolveContext } from "@testpilot/harness-core";
import { executeRun } from "@testpilot/harness-testing/exec";
import { Held, type DetectionEvalResult, type ExecOutcome } from "./contracts.js";
import { describeEnvironment, resolveEnvironment, type ResolvedEnvironment } from "./environment.js";
import { DEFAULT_RUNS_DIR, readFullCases, readMeta, resolveRunDir, type FullCase } from "./runs.js";

/** 仓库根。数据目录（`server/.data`）相对它算。 */
const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/**
 * `${env.*}` / `${secret.*}` 从进程环境解。
 *
 * 用例里**不写明文口令**（规格第 3 节写死的），所以解不开的占位符会原样留在步骤里，
 * 而那正是要的：一条带着 `${secret.PASSWORD}` 字样去点输入框的用例会失败得很明显，
 * 比悄悄用一个空字符串登录、然后报告「产品拒绝了正确凭证」要好得多。
 */
function resolveContext(
  vars: Record<string, string | string[]> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolveContext {
  const secrets: Record<string, string> = {};
  const plain: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/PASSWORD|SECRET|TOKEN|KEY/i.test(k)) secrets[k] = v;
    else plain[k] = v;
  }
  // 环境记录里的 `vars` **压过**进程环境：它是人在界面上为这个被测对象配的那一份,
  // 而进程环境是这台机器上碰巧有的东西。
  for (const [k, v] of Object.entries(vars)) plain[k] = v;
  return { env: plain, secrets };
}

/** `RunResult` → `ExecOutcome`：去掉 `Buffer`，别的一个字段都不改名。 */
function project(caseId: string, r: Awaited<ReturnType<typeof executeRun>>): ExecOutcome {
  return {
    caseId,
    status: r.status,
    durationMs: r.durationMs,
    startedAt: r.startedAt,
    logs: r.logs,
    screenshots: r.screenshots,
    oracle: r.oracle,
    failureReason: r.failureReason,
    infraError: r.infraError,
    failure: r.failure,
    endedAt: r.endedAt,
    mutationApplied: r.mutationApplied,
  };
}

function findCase(cases: FullCase[], caseId: string): FullCase {
  const found = cases.find((c) => c.id === caseId);
  if (found) return found;
  const near = cases
    .filter((c) => c.id?.includes(caseId) || c.title?.includes(caseId))
    .slice(0, 3)
    .map((c) => c.id);
  throw new Error(
    `no case "${caseId}" in this run (${cases.length} cases)` +
      (near.length ? `. Did you mean: ${near.join(", ")}?` : `. First ids: ${cases.slice(0, 3).map((c) => c.id).join(", ")}`),
  );
}

export interface DriveSutOptions {
  runId: string;
  caseId: string;
  /** 直接给的目标 URL。要登录的产品应当改用 `env` + `projectId`——见 `environment.ts`。 */
  target?: string;
  env?: string;
  projectId?: string;
  apiBase?: string;
  viewport?: { width?: number; height?: number };
  runsDir?: string;
  /**
   * 只解析、不执行。
   *
   * 存在的理由不是「方便测试」：一次真跑要起浏览器、要打模型、会在被测产品上留下痕迹，
   * 而**这次要跑成什么样**（哪个环境、有没有会话、多大视口、打哪个端点）是可以先看一眼的。
   * 看一眼再决定跑不跑，比跑完再发现环境选错了便宜得多。
   */
  dryRun?: boolean;
}

export interface DriveSutPlan {
  caseId: string;
  title: string;
  url: string;
  steps: string[];
  expected: string;
  postSteps: string[];
  environment: Record<string, unknown>;
  dryRun: true;
  note: string;
}

/** 一条用例，跑一次，如实回报。判定由 `executeRun` 的 oracle 层做，不由这里再判一次。 */
export async function driveSut(opts: DriveSutOptions): Promise<ExecOutcome | DriveSutPlan> {
  const runDir = resolveRunDir(opts.runId, opts.runsDir ?? DEFAULT_RUNS_DIR);
  readMeta(runDir); // 没有印记的运行，它的执行结果也没法归属到任何一版
  const kase = findCase(readFullCases(runDir), opts.caseId);

  /**
   * 被测对象的三态（借 commerce-agents 的 enable_* / unwired / NotOffered）：
   *
   * - **absent**：没有 target 也没有 projectId——这次运行根本没有被测对象。不是故障，
   *   是「这里没有这个系统」；模型该说「没有可执行的目标」，而不是重试或编一个地址。
   * - **unwired**：有目标但接不上——环境记录取不到、会话导入过期、网关不可达。系统存在，
   *   只是没接好；结果是「暂不可用」，重试或修接线是对的。
   * - **not offered**：目标在、接上了，但这条用例要走的路由/控件被测对象没有——
   *   由执行结果的 `unobservable` 表达（判据没量到），不在这里。
   *
   * 三种此前混成一个 throw，模型读到的都是「工具坏了」。分开之后前两种是 `blocked(gate=sut)`，
   * reason 的第一个词说明是哪一种。
   */
  if (!opts.target && !opts.projectId)
    throw new Held(
      "sut",
      "absent: drive_sut has no system under test — pass target (a bare URL) or projectId (+ optional env) so the " +
        "environment record (session, viewport, headers, variables) can be resolved. Nothing is misconfigured; " +
        "this run simply names no target, so say so instead of inventing one.",
    );

  let environment: ResolvedEnvironment;
  try {
    environment = await resolveEnvironment({
      env: opts.env,
      projectId: opts.projectId,
      apiBase: opts.apiBase,
      target: opts.target,
      viewport: opts.viewport,
      repoRoot: REPO_ROOT,
    });
  } catch (e) {
    throw new Held(
      "sut",
      `unwired: the system under test exists but could not be reached or resolved — ${(e as Error).message}. ` +
        "This is a wiring problem (session import, gateway, environment record), not a property of the product; fix the wiring and call again.",
    );
  }
  if (!environment.baseUrl)
    throw new Held("sut", `unwired: environment "${environment.name}" has no baseUrl to navigate to`);

  if (opts.dryRun)
    return {
      caseId: kase.id,
      title: kase.title,
      url: environment.baseUrl,
      steps: kase.steps,
      expected: kase.expected,
      postSteps: kase.postSteps ?? [],
      environment: describeEnvironment(environment),
      dryRun: true,
      note: "nothing was executed: no browser was launched and the system under test was not touched",
    };

  const r = await executeRun(environment.baseUrl, kase.steps, kase.expected, execOpts(kase, environment));
  return project(kase.id, r);
}

/**
 * 一次执行要带的全部环境。
 *
 * `storageState` 在这里第一次、也是唯一一次离开 `environment.ts`——它进的是
 * `executeRun` 的参数，不进返回值、不进日志、不进 `runs/`。
 */
function execOpts(kase: FullCase, env: ResolvedEnvironment) {
  return {
    postSteps: kase.postSteps,
    resolve: resolveContext(env.vars),
    extraHeaders: env.headers,
    query: env.query,
    viewport: env.viewport,
    storageState: (env.session ?? null) as never,
    // profile 自带登录态时,executeRun 会据此跳过 storageState 注入(两条路只走一条)。
    sutProfileDir: env.sutProfileDir ?? undefined,
  };
}

/* ------------------------------------------------------------ 变异与检出 */

/**
 * 这个变异到底注进去了没有。
 *
 * 判据是确定性的、不问模型的：把健康版取两遍，再取一遍注入版。
 *   两遍健康版就不一样  → 页面本身每次都在变，这个判据用不了，报 `unknown`
 *   健康 == 注入        → 参数被忽略了，变异**没注进去**
 *   健康 != 注入        → 注进去了
 *
 * 先比两遍健康版这一步不能省：少了它，一个每次渲染都带时间戳的页面会被判成
 * 「注进去了」，然后它的存活会被当成用例集的盲区——那正是这个检查要防的错误方向。
 *
 * 这段是从 `server/src/evals.ts` 的 `runDetectionEval` 原样搬过来的，
 * 因为它已经在真产品上救过一次场：PetClinic 那次 5 个变异体全部「活下来」，
 * 而 `/` 和 `/?defect=no-error` 的响应逐字节相同——一个「0 分」读起来是
 * 「这套用例什么都抓不到」，事实是「这次实验根本没发生」。
 */
async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/** 被测对象自己声明它能注哪些缺陷。问它，而不是在这里硬编一份会过期的清单。 */
async function advertisedDefects(target: string): Promise<Record<string, string>> {
  try {
    const origin = new URL(target).origin;
    const res = await fetch(`${origin}/api/defects`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return {};
    const body = (await res.json()) as { defects?: Record<string, { title?: string }> };
    return Object.fromEntries(Object.entries(body.defects ?? {}).map(([k, v]) => [k, v.title ?? k]));
  } catch {
    return {};
  }
}

export interface MutateAndDetectOptions {
  runId: string;
  target: string;
  defects?: string[];
  runsDir?: string;
  limit?: number;
}

/**
 * 注一个人造缺陷，看这套用例会不会叫。
 *
 * 刻意**不做** per-case 的 precision/recall：那需要一条「这条用例本该抓到这个缺陷」的
 * 标注，而那种标注只能自己编，编出来量的是标注质量，不是用例集质量。
 * 不用编就能知道的是这两件：
 *
 *   健康版 → 任何一条失败都是虚报（产品没毛病，就不该有人叫）
 *   注入版 → 这个缺陷有没有被**任何一条**用例注意到（杀掉 / 存活）
 *
 * `leaning` 用的是 `harness-core/eval/detect.ts` 的同一条阈值（0.5），
 * 只是把两个输入换成能诚实拿到的那两个：变异分数替召回，虚报率替精确。
 */
export async function mutateAndDetect(opts: MutateAndDetectOptions): Promise<DetectionEvalResult> {
  const runDir = resolveRunDir(opts.runId, opts.runsDir ?? DEFAULT_RUNS_DIR);
  const meta = readMeta(runDir);
  if (!/^https?:\/\//.test(opts.target))
    throw new Error(`target must be an http(s) URL, got "${opts.target}"`);

  const all = readFullCases(runDir);
  if (!all.length) throw new Error(`run ${opts.runId} has no cases to execute`);
  const cases = all.slice(0, opts.limit ?? 3);

  const titles = await advertisedDefects(opts.target);
  const wanted = opts.defects?.length ? opts.defects : Object.keys(titles);
  if (!wanted.length)
    throw new Error(
      `${opts.target} advertises no injectable faults (GET /api/defects returned nothing) and none were named. ` +
        `A detection run with no faults measures nothing — pass { defects: [...] } or point at a target that supports ?defect=.`,
    );

  const id = `det-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  const withDefect = (d: string) => `${opts.target}${opts.target.includes("?") ? "&" : "?"}defect=${d}`;
  const resolveCtx = resolveContext();  // 变异跑在内置 fixture 上，没有环境记录要解
  const run = (c: FullCase, url: string) =>
    executeRun(url, c.steps, c.expected, { postSteps: c.postSteps, resolve: resolveCtx });

  const probeApplied = async (defect: string): Promise<"yes" | "no" | "unknown"> => {
    const h1 = await fetchText(opts.target);
    const h2 = await fetchText(opts.target);
    const mutated = await fetchText(withDefect(defect));
    if (h1 === undefined || h2 === undefined || mutated === undefined) return "unknown";
    if (h1 !== h2) return "unknown";
    return h1 === mutated ? "no" : "yes";
  };

  // 1. 健康版。这里的失败说明不了产品的任何事——它说明这条用例本身在叫。
  const falseAlarms: string[] = [];
  for (const c of cases) {
    const outcome = await run(c, opts.target);
    if (outcome.status === "failed" && !outcome.infraError) falseAlarms.push(c.id);
  }

  // 2. 一个缺陷一轮。
  const mutants: DetectionEvalResult["mutants"] = [];
  for (const defect of wanted) {
    const applied = await probeApplied(defect);
    // 注不进去就别跑：一整轮用例跑在健康版上，除了烧钱什么也说明不了。
    if (applied === "no") {
      mutants.push({ defect, title: titles[defect] ?? defect, killed: false, killedBy: [], ran: 0, applied });
      continue;
    }
    const killedBy: string[] = [];
    let ran = 0;
    for (const c of cases) {
      // 一条在健康版上就叫的用例，杀掉不能算它的。
      if (falseAlarms.includes(c.id)) continue;
      const outcome = await run(c, withDefect(defect));
      // 没量到的判据没有判决：不算杀死，也不进分母。
      if (outcome.status === "unobservable") continue;
      ran += 1;
      if (outcome.status === "failed" && !outcome.infraError) killedBy.push(c.id);
    }
    mutants.push({ defect, title: titles[defect] ?? defect, killed: killedBy.length > 0, killedBy, ran, applied });
  }

  const graded = mutants.filter((m) => m.applied !== "no");
  const caught = graded.length ? graded.filter((m) => m.killed).length / graded.length : 0;
  const noisy = falseAlarms.length / (cases.length || 1);

  return {
    id,
    runId: meta.runId,
    falseAlarms,
    falseAlarmRate: cases.length ? Number((falseAlarms.length / cases.length).toFixed(3)) : 0,
    mutants,
    // 分母只算真的注进去了的。没发生的实验不该拉低分数——那会把工具自己的失败
    // 伪装成用例集的盲区，而虚低的那部分看起来像真发现。
    mutationScore: graded.length ? Number(caught.toFixed(3)) : 0,
    notApplied: mutants.filter((m) => m.applied === "no").length,
    cases: cases.length,
    leaning: !graded.length && !cases.length ? "undetermined" : noisy >= 0.5 ? "false-alarms" : caught < 0.5 ? "silence" : "balanced",
    note:
      "mutation score is a suite-level number: a fault counts as caught if any case notices it. " +
      "Faults that could not be injected are excluded from the denominator, not counted as survivors. " +
      "Per-case precision/recall would need labels that do not exist for these cases.",
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
