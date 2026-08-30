import { listCases, type TestCase } from "./db.js";
import { allOutputs, nodeOutput, outputStore } from "./graphs.js";
import { normalise } from "@testpilot/harness-testing";

/**
 * 需求追溯：每条用例指回哪一句规格，以及**断言凭什么这么写**。
 *
 * 追溯有两个方向，都要能答：
 *   - 用例 → 故事：指不回任何故事的用例是没人能复核的用例（门禁①的 `traceability` 规则）。
 *   - 故事 → 用例：一条没有任何用例的故事，是覆盖率里那个"下界"的来源。
 *
 * 第三件事才是这一节真正稀缺的：**锚点**。规格承诺了一条规则，不等于产品会显示那六个字。
 * 一条断言如果引用了界面文案（「已停止」、"Invalid username or password"），那这串字应当能在
 * 喂给这次运行的材料里查到。
 *
 * 查不到**不等于**编造：可能是模型编的，也可能是产品确实这么显示、只是规格没写。两者都值得标出来，
 * 但结论不同——前者要改用例，后者要补规格。所以这一列的名字是「材料里查不到依据」，
 * 不是「错的」；它给的是"这条断言能不能自证"的下界，不是对错判决。
 *
 * 判定是确定性的字符串检查，不是再问一次模型：一个用模型来判自己有没有编造的检查，
 * 量的是模型的自评，不是事实。代价是引号以外的编造抓不到——所以「没有可查的引文」
 * 单独成一档，而不是算作通过。
 */

interface Story {
  id: string;
  title: string;
  acceptance?: string[];
  source?: string;
  /** 指回规格里的哪一条需求。追溯的第三根轴——名字承诺了它，此前轴上没有它。 */
  requirementId?: string;
}

/** Quoted UI text inside an assertion — the part that makes a claim about the product. */
const QUOTED = /[「『“"']([^「『”"'\n]{2,60})[」』”"']/g;

export function literalsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const lit = m[1].trim();
    // A bare number or a single word in quotes says nothing about the interface; requiring
    // it to be present in the spec would flag ordinary prose as fabrication.
    if (lit.length < 2 || /^\d+$/.test(lit)) continue;
    // 带占位符的引文不是一句可查的界面文案：`Welcome, ${env.VALID_USERNAME}` 真正显示成
    // 什么，取决于运行时的环境，材料里当然查不到它。把它算作「查不到出处」，等于因为
    // 一条用例**正确地**参数化了凭证而扣它的分——而参数化恰恰是这个项目要求的做法。
    // 它属于「没有可查的引文」那一档，不属于「编的」。
    if (lit.includes("${")) continue;
    out.push(lit);
  }
  return [...new Set(out)];
}

export interface TraceRow {
  caseId: string;
  title: string;
  storyId?: string;
  storyTitle?: string;
  acceptance: string[];
  /** orphan: points at no story, or at one this run never produced. */
  orphan: boolean;
  /** Literals the assertion quotes, each with whether the source material contains it. */
  anchors: Array<{
    text: string;
    grounded: boolean;
    /** 在哪一份里查到的：`material` 是喂进去的原始材料，`spec` 是整理之后的规格。 */
    where?: "material" | "spec";
  }>;
  /** No quoted interface text at all — nothing to check, which is not the same as passing. */
  unanchored: boolean;
  sourceRunId?: string;
  /** 这条用例最终指回哪一条需求。用例自己不知道，它继承自所属的故事。 */
  requirementId?: string;
}

export interface StoryRow {
  storyId: string;
  title: string;
  cases: number;
  source?: string;
}

/** 一条需求，以及它下面有几条故事、几条用例。追溯的第三根轴。 */
export interface RequirementRow {
  requirementId: string;
  stories: number;
  cases: number;
}

export interface TraceReport {
  rows: TraceRow[];
  stories: StoryRow[];
  /** 需求 → 故事 → 用例。一条没有用例的需求，是覆盖率那个下界里最该被看见的一档。 */
  requirements: RequirementRow[];
  orphans: number;
  /** Stories with no case at all. Coverage's lower bound, stated as a list rather than a %. */
  uncovered: number;
  /** How many assertions quote something that could not be found in the material. */
  ungrounded: number;
}

/** The stories and the raw material a run was given, cached per run within one report. */
async function runContext(
  wfRunId: string,
): Promise<{ stories: Story[]; material: string; spec: string }> {
  const stories = ((await nodeOutput(wfRunId, "stories").catch(() => undefined)) as
    | { stories?: Story[] }
    | undefined)?.stories;
  return { stories: stories ?? [], ...(await groundTruth(wfRunId)) };
}

/**
 * 拿什么来判断一句界面文案「查得到出处」。
 *
 * 应该是**喂给这次运行的材料**，不是整理之后的规格。此前查的是 `spec` 节点的产物——而在
 * 现在的图里那已经是 `spec.compose` 的输出，一份被整理和压缩过的东西。材料里明明写着的
 * 一句界面文案，只要整理者转述了它，就会被判成「查不到出处」。这个检查因此系统性地
 * 高报，而它高报的方向恰好是最容易让人不再相信它的方向。
 *
 * 两份都留着，分开判：在材料里查到是最强的一档；只在整理后的规格里查到说明整理者写下了
 * 它但材料里没有，那是另一件事，也值得知道。
 *
 * 材料节点不按 id 找——不同的图里它叫 `docs` 或 `explore`。按形状找：有 `text`、没有
 * `rules` 的那一份就是材料，有 `rules` 的是整理后的规格。
 */
async function groundTruth(wfRunId: string): Promise<{ material: string; spec: string }> {
  let material = "";
  let spec = "";
  const outputs = await allOutputs(wfRunId).catch(() => ({}) as Record<string, unknown>);
  for (const value of Object.values(outputs)) {
    if (!value || typeof value !== "object") continue;
    const o = value as { text?: unknown; rules?: unknown };
    if (typeof o.text !== "string" || !o.text) continue;
    if (Array.isArray(o.rules)) spec ||= o.text;
    else material ||= o.text;
  }
  return { material, spec };
}

/**
 * 追溯要的那点用例信息。
 *
 * 抽出来是为了让**还没批准的那一批**也能追溯。此前这一页只读 `listCases(projectId)`，
 * 也就是已经进了看板的用例——于是复核者在复核这一批的时候，恰恰不能用追溯视图来复核它：
 * 要看追溯得先批准，批准又需要先复核，顺序是反的。
 */
interface TraceableCase {
  id: string;
  title: string;
  storyId?: string;
  expected?: string;
  sourceRunId?: string;
}

export async function traceability(projectId: string): Promise<TraceReport> {
  return build(listCases(projectId) as TraceableCase[]);
}

/**
 * 对一次运行刚生成、还没批准的那一批做追溯。
 *
 * 和已批准的走同一套判定：同一件事有两套算法，迟早会给出两个数，而没人说得清哪个对。
 */
export async function traceabilityOfRun(wfRunId: string): Promise<TraceReport> {
  const gated = (await nodeOutput(wfRunId, "gate").catch(() => undefined)) as
    | { cases?: Array<{ id: string; storyId?: string; title: string; expected?: string }> }
    | undefined;
  return build(
    (gated?.cases ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      storyId: c.storyId,
      expected: c.expected,
      sourceRunId: wfRunId,
    })),
  );
}

async function build(cases: TraceableCase[]): Promise<TraceReport> {
  const ctx = new Map<string, { stories: Story[]; material: string; spec: string }>();
  const rows: TraceRow[] = [];
  const perStory = new Map<string, number>();
  const perReq = new Map<string, number>();

  for (const kase of cases) {
    const runId = kase.sourceRunId;
    if (runId && !ctx.has(runId) && outputStore.getRun(runId)) ctx.set(runId, await runContext(runId));
    const { stories, material, spec } = ctx.get(runId ?? "") ?? { stories: [], material: "", spec: "" };
    const story = stories.find((s) => s.id === kase.storyId);

    const anchors = literalsIn(kase.expected ?? "").map((text) => {
      // 空白折叠后再比，和整理规格时定位原话用的是同一套归一化：换行和缩进不该算差别，
      // 标点该算——界面文案的断言正活在这种细节上。
      const needle = normalise(text);
      const inMaterial = !!material && normalise(material).includes(needle);
      const inSpec = !!spec && normalise(spec).includes(needle);
      return {
        text,
        // Without material there is nothing to check against, so nothing is called fabricated:
        // an absent source would otherwise turn every case red for the wrong reason.
        grounded: !material && !spec ? true : inMaterial || inSpec,
        // 在材料里查到，还是只在整理后的规格里查到——后者说明这句话是整理者写下的，
        // 材料里没有。两者都不是编造，但要改的东西不一样。
        where: inMaterial ? ("material" as const) : inSpec ? ("spec" as const) : undefined,
      };
    });

    if (kase.storyId) perStory.set(kase.storyId, (perStory.get(kase.storyId) ?? 0) + 1);
    if (story?.requirementId) perReq.set(story.requirementId, (perReq.get(story.requirementId) ?? 0) + 1);

    rows.push({
      caseId: kase.id,
      title: kase.title,
      storyId: kase.storyId,
      storyTitle: story?.title,
      acceptance: story?.acceptance ?? [],
      // A case with no story at all, and a case pointing at a story that does not exist, are
      // the same problem to a reviewer: there is nothing to check it against.
      orphan: !kase.storyId || (stories.length > 0 && !story),
      anchors,
      unanchored: anchors.length === 0,
      sourceRunId: runId,
      requirementId: story?.requirementId,
    });
  }

  // 按 id 去重：几条用例可能来自同一次运行，也可能来自几次共享故事的运行。
  const allStories = new Map<string, Story>();
  for (const { stories } of ctx.values()) for (const s of stories) if (!allStories.has(s.id)) allStories.set(s.id, s);
  const seen = new Map<string, StoryRow>(
    [...allStories.values()].map((s) => [
      s.id,
      { storyId: s.id, title: s.title, cases: perStory.get(s.id) ?? 0, source: s.source },
    ]),
  );

  const storyRows = [...seen.values()].sort((a, b) => a.storyId.localeCompare(b.storyId));

  /**
   * 需求那一根轴。
   *
   * 故事数从**这次运行产出的全部故事**里数，不是从有用例的那些里数——一条需求下面
   * 有三条故事而只有一条有用例，正是这张表要说的话。
   */
  const reqStories = new Map<string, number>();
  for (const s of allStories.values())
    if (s.requirementId) reqStories.set(s.requirementId, (reqStories.get(s.requirementId) ?? 0) + 1);
  const requirements: RequirementRow[] = [...new Set([...reqStories.keys(), ...perReq.keys()])]
    .sort()
    .map((requirementId) => ({
      requirementId,
      stories: reqStories.get(requirementId) ?? 0,
      cases: perReq.get(requirementId) ?? 0,
    }));

  return {
    rows,
    stories: storyRows,
    requirements,
    orphans: rows.filter((r) => r.orphan).length,
    uncovered: storyRows.filter((s) => s.cases === 0).length,
    ungrounded: rows.reduce((n, r) => n + r.anchors.filter((a) => !a.grounded).length, 0),
  };
}
