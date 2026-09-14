import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ABLATABLE } from "@testpilot/harness-core";

/**
 * 评测集，作为仓库里的文件。
 *
 * 此前一次配对评测是一个 POST body：在界面上填两组参数、点运行、结果进 SQLite。
 * 结果进数据库是对的——那是产物。但**定义**也只活在那一次请求里，于是「这个 harness
 * 到底拿什么在考自己」这个问题，没有任何地方能回答：它没有历史、进不了 review、
 * 没法 diff，改了没有人看得见。
 *
 * 所以定义搬到 `evals/*.json`。这不是为了整齐——评测集是这个项目唯一的判断依据，
 * 一份判断依据如果可以被人在界面上随手改掉且不留痕迹，它就不再是判断依据。
 *
 * ## `expect` 为什么不是断言
 *
 * 每份定义要求先写下预期（哪一边会更好，以及为什么）。它**不会**让评测失败——
 * 一个会红的评测会被人调到绿为止，而那正是评测本该防住的事。它只被记下来，跑完
 * 和实际结果并排显示。写下预期再看它对不对，是评测唯一能防止自欺的机制；
 * 跑完之后再解释为什么这个结果是意料之中的，不是。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
const EVAL_DIR = resolve(REPO_ROOT, "evals");

export interface EvalArmSpec {
  label: string;
  /** 关掉哪些组件。只认 ABLATABLE 里真的有节点在读的名字。 */
  ablate: string[];
  /** 逐节点的参数覆盖，例如 { gate: { minNegativeRatio: 0.5 } }。 */
  params?: Record<string, Record<string, unknown>>;
  /** 或者按原样跑图的某个历史版本。 */
  graphVersion?: number;
  /** 07 T-22：两臂只差运行时（penguin / claude-code / codex）。同一份 skill + gold + MCP，换的是执行它们的 harness。 */
  runtime?: string;
}

export interface EvalSpec {
  /** 文件名即 id，这里再写一遍是为了让文件自己能说清自己是谁。 */
  id: string;
  title: string;
  /**
   * 为什么问这个问题。必填，而且不能是复述标题。
   *
   * 一份说不出自己在问什么的评测，跑出来的数字没人知道该拿它干什么——它最后会变成
   * 一个大家都看、但谁也不会据此改任何东西的仪表盘。
   */
  why: string;
  graphId: string;
  goldPath?: string;
  casesNode?: string;
  seed?: unknown;
  a: EvalArmSpec;
  b: EvalArmSpec;
  expect?: {
    /** 跑之前就写下来的预判。`unknown` 是诚实的答案，不是偷懒。 */
    direction: "a-better" | "b-better" | "no-difference" | "unknown";
    note: string;
  };
}

export interface LoadedSpec extends EvalSpec {
  /** 相对仓库根的路径，让报告能指回文件。 */
  path: string;
}

/** 一份定义读不出来时说清是哪一份、坏在哪——静默跳过会让评测集悄悄变小。 */
export interface SpecProblem {
  path: string;
  error: string;
}

const DIRECTIONS = ["a-better", "b-better", "no-difference", "unknown"] as const;

/**
 * 手写校验而不是引一个 schema 库：这里唯一的读者是正在编辑一个 JSON 文件的人，
 * 而他需要的是「哪一行错了、为什么这条规则存在」，不是一串路径加类型名。
 */
function str(o: Record<string, unknown>, key: string, min = 1): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim().length < min)
    throw new Error(`\`${key}\` 必须是一个至少 ${min} 个字符的字符串`);
  return v;
}

function arm(raw: unknown, which: "a" | "b"): EvalArmSpec {
  if (!raw || typeof raw !== "object") throw new Error(`\`${which}\` 必须是一个对象`);
  const o = raw as Record<string, unknown>;
  const label = str(o, "label");
  const ablate = o.ablate ?? [];
  if (!Array.isArray(ablate) || ablate.some((x) => typeof x !== "string"))
    throw new Error(`\`${which}.ablate\` 必须是字符串数组`);
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null))
    throw new Error(`\`${which}.params\` 必须是 { 节点: { 参数: 值 } }`);
  if (o.graphVersion !== undefined && !Number.isInteger(o.graphVersion))
    throw new Error(`\`${which}.graphVersion\` 必须是整数`);
  return {
    label,
    ablate: ablate as string[],
    ...(typeof o.runtime === "string" ? { runtime: o.runtime } : {}),
    params: o.params as Record<string, Record<string, unknown>> | undefined,
    graphVersion: o.graphVersion as number | undefined,
  };
}

function validate(raw: unknown, path: string): LoadedSpec {
  if (!raw || typeof raw !== "object") throw new Error("文件的顶层必须是一个对象");
  const o = raw as Record<string, unknown>;
  const spec: EvalSpec = {
    id: str(o, "id"),
    title: str(o, "title"),
    why: str(o, "why", 10),
    graphId: str(o, "graphId"),
    goldPath: typeof o.goldPath === "string" ? o.goldPath : undefined,
    casesNode: typeof o.casesNode === "string" ? o.casesNode : undefined,
    seed: o.seed,
    a: arm(o.a, "a"),
    b: arm(o.b, "b"),
  };
  if (o.expect !== undefined) {
    const e = o.expect as Record<string, unknown>;
    if (!DIRECTIONS.includes(e.direction as (typeof DIRECTIONS)[number]))
      throw new Error(`\`expect.direction\` 必须是 ${DIRECTIONS.join(" / ")} 之一`);
    spec.expect = {
      direction: e.direction as EvalSpec["expect"] extends undefined ? never : "a-better",
      note: typeof e.note === "string" ? e.note : "",
    };
  }

  const bad = [...spec.a.ablate, ...spec.b.ablate].filter(
    (x) => !(ALL_ABLATABLE as string[]).includes(x),
  );
  // 一个没有节点在读的开关，会让消融报告显示"关掉它没有影响"——那句话是真的，
  // 但它说的不是这个组件不重要，而是这个开关根本没接上。
  if (bad.length)
    throw new Error(`未知的消融开关：${bad.join(", ")}（认得的有：${ALL_ABLATABLE.join(", ")}）`);
  if (spec.a.label === spec.b.label) throw new Error("两组的 label 相同，报告会读不出谁是谁");
  // 两组完全一样的"配对评测"量的是噪声，而它看起来和一个真实结论一模一样。
  if (
    JSON.stringify({ ...spec.a, label: "" }) === JSON.stringify({ ...spec.b, label: "" })
  )
    throw new Error("两组的配置完全相同——这样量到的只有噪声");
  return { ...spec, path };
}

export function listEvalSpecs(): { specs: LoadedSpec[]; problems: SpecProblem[] } {
  if (!existsSync(EVAL_DIR)) return { specs: [], problems: [] };
  const specs: LoadedSpec[] = [];
  const problems: SpecProblem[] = [];
  for (const name of readdirSync(EVAL_DIR).sort()) {
    if (!name.endsWith(".json")) continue;
    const rel = `evals/${name}`;
    try {
      const raw = JSON.parse(readFileSync(resolve(EVAL_DIR, name), "utf8")) as unknown;
      const spec = validate(raw, rel);
      if (spec.id !== name.replace(/\.json$/, ""))
        throw new Error(`id 是 "${spec.id}"，但文件叫 ${name}——两者必须一致，否则引用它的地方对不上`);
      specs.push(spec);
    } catch (e) {
      problems.push({ path: rel, error: (e as Error).message });
    }
  }
  return { specs, problems };
}

export function getEvalSpec(id: string): LoadedSpec | undefined {
  return listEvalSpecs().specs.find((s) => s.id === id);
}

/**
 * 从一条 critic 建议造一份**可以直接跑**的评测定义。
 *
 * critic 提得出改进建议，但产物是**给人读的文字**——而 `evals/*.json` 今天全部手写。
 * 于是两头都在：一边是「这里可能有问题」，一边是「这个 harness 拿什么考自己」，
 * 中间没有路。这个函数就是那条路。
 *
 * 三条纪律：
 * ① 只有**说得出怎么证伪**的建议才生成得出来（`test.kind` 是 ablation 或 param）。
 *    一条 manual 的建议造不出两条臂——硬造出来的那两条臂量的是别的东西。
 * ② `why` 必填而且不能是复述标题：一份说不出自己在问什么的评测，
 *    最后会变成一个大家都看、但谁也不会据此改任何东西的仪表盘。
 * ③ `expect` 是**预注册**的，不是断言。它记下我们跑之前的判断，跑完之后对账——
 *    一个会红的评测会被人调到绿为止，而那正是评测本该防住的事。
 *
 * 走 `validate()` 落盘，所以一份造出来的定义和一份手写的受同一套检查：
 * 未知的开关、两条一样的臂、label 撞名，全都当场拒。
 */
export function specFromSuggestion(input: {
  suggestion: {
    title: string;
    change: string;
    evidence: string;
    expectedEffect?: string;
    test: { kind: "ablation" | "param" | "manual"; handle?: string };
    inadmissible?: string;
  };
  graphId: string;
  /** 预判：跑之前写下来的那一句。不给就记成 `unknown`——诚实，不是偷懒。 */
  expect?: { direction: "a-better" | "b-better" | "no-difference" | "unknown"; note: string };
  goldPath?: string;
}): LoadedSpec {
  const s = input.suggestion;
  if (s.inadmissible)
    throw new Error(`这条建议被判为不可采纳（${s.inadmissible}）——不该被造成一份评测`);
  if (s.test.kind === "manual" || !s.test.handle)
    throw new Error(
      `这条建议说不出怎么证伪（test.kind=${s.test.kind}）。一份配对评测需要两条**只差一处**的臂，` +
        `而硬造出来的那两条臂量的是别的东西。`,
    );

  const id = `critic-${slug(s.title)}`;
  /*
   * 两条臂**只差一处**：基线，和改了那一处之后。
   *
   * 这是配对评测唯一能成立的形状——差两处的两条臂，量出来的差异归不到任何一处上。
   */
  const arms =
    s.test.kind === "ablation"
      ? {
          a: { label: "baseline", ablate: [] as string[] },
          b: { label: `without ${s.test.handle}`, ablate: [s.test.handle] },
        }
      : (() => {
          // "node.param=value"
          const m = /^([\w.-]+)\.([\w-]+)=(.*)$/.exec(s.test.handle ?? "");
          if (!m) throw new Error(`参数写法要是 "节点.参数=值"，收到的是 "${s.test.handle}"`);
          const [, node, param, raw] = m;
          const value: unknown = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
          return {
            a: { label: "baseline", ablate: [] as string[] },
            b: { label: `${node}.${param}=${raw}`, ablate: [] as string[], params: { [node]: { [param]: value } } },
          };
        })();

  const spec = {
    id,
    title: s.title,
    // 证据就是这份评测存在的理由——把 critic 手里那份原样带过来，别让它在路上蒸发。
    why: `${s.change}\n\n证据：${s.evidence}`,
    graphId: input.graphId,
    ...(input.goldPath ? { goldPath: input.goldPath } : {}),
    ...arms,
    expect: input.expect ?? {
      direction: "unknown" as const,
      note: s.expectedEffect || "critic 没有说出它预期哪一边更好——unknown 是诚实的答案",
    },
  };

  const rel = `evals/${id}.json`;
  const checked = validate(spec, rel);
  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(resolve(EVAL_DIR, `${id}.json`), JSON.stringify(spec, null, 2) + "\n");
  return checked;
}

/** 标题变成一个能当文件名的 id。 */
function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "untitled";
}
