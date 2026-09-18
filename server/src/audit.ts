/**
 * 审计台的服务端：三个 GET + 一个 POST。
 *
 * 形状**不是这里定的**——`src/lib/audit.ts`（Phase 2 已完成）把请求与响应写死了，
 * 这个文件按它实现。那份文件里最要紧的一条约定是：
 *
 *   > 只吞 404 与网络错误。**5xx 照样抛**——那是"建了但坏了"，必须看得见。
 *
 * 所以这里的每一个「没有」都要认真选状态码：`gold.json` 还没写、`scans/<runId>.json`
 * 还没跑过，是 **404**（前端退回假数据并在页头说明白）；而读到了却读坏了，是 500。
 * 把两者混成一个码，界面上就只剩一句技术错误，人无从判断是"还没建"还是"坏了"。
 *
 * 三份集合的来历见 `src/lib/audit.ts` 顶部那段：人不是评分员，人标样本（校准）、
 * 看机器觉得可疑的那些（审计报告）、只处理被标出来的（变化）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cohensKappa, covers } from "@testpilot/harness-core";
import type { ScanReport } from "testpilot-mcp/contracts";
import { listReviewDecisions } from "./db.js";
import { outputStore } from "./graphs.js";
import { REPO_ROOT, defaultWorkspace, readRun, resolveRunDir } from "./penguin.js";
import { workspaceOf } from "./penguinRun.js";

/* ── 契约类型（照抄 `src/lib/audit.ts`，一个字段都不改名） ───────────────── */

export interface HumanLabel {
  goldId: string;
  caseId: string;
  runId: string;
  covered: boolean;
  by: string;
  at: string;
  heldOut: boolean;
}

export interface CalibrationItem {
  caseId: string;
  goldId: string;
  goldTitle: string;
  heldOut: boolean;
}

export interface CalibrationPayload {
  sample: CalibrationItem[];
  labels: HumanLabel[];
  kappa?: number;
}

export type { ScanFinding, ScanReport } from "testpilot-mcp/contracts";

export interface DiffPayload {
  added: string[];
  removed: Array<{ caseId: string; title: string }>;
  changed: Array<{ caseId: string; before: { expected: string }; after: { expected: string } }>;
}

/** 「没有这个东西」和「这个东西坏了」必须分得开。前者是 404。 */
export class NotFound extends Error {
  readonly status = 404;
}

/* ── 目录 ─────────────────────────────────────────────────────────────── */

/**
 * 能力单元 = 目录（架构 §5）。
 *
 * `casegen`：自举基准，仓库里唯一有冻结 gold 的那个。`TP_CAPABILITY` 可以改，
 * 但**不要在一次校准跑到一半时改**——`human-labels.json` 是按能力分目录存的，
 * 改一次等于把已标的那些留在另一个目录里，而界面上只会显示"还没标"。
 */
export const CAPABILITY = process.env.TP_CAPABILITY || "casegen";

/**
 * `benchmark/<capability>/`。
 *
 * 架构 §2 把它画在**仓库根**上：gold 与 human-labels 是要进版本库的资产
 * （P2「考卷不能由考生出」靠的就是它们有历史、有 diff、有 blame）。
 * 工作区里那份只作回落——自举时 SUT 是另一个实例，它有自己的 benchmark。
 */
/**
 * 读一份基准文件：仓库根优先，工作区回落，**按文件逐个判**。
 *
 * 按目录判会出一个很隐蔽的错：写一次 labels 会把仓库根那个目录建出来，
 * 于是「哪个目录存在」翻转，`gold.json` 的查找也跟着翻到那边——而那边只有 labels。
 * 结果是标完第一批之后校准端点突然开始返回 404。一份一份地找就没有这个耦合。
 */
export function benchmarkRead(rel: string, cap = CAPABILITY, workspace?: string): string | undefined {
  const candidates = [
    join(benchmarkWriteDir(cap), rel),
    join(workspace ?? defaultWorkspace(), "benchmark", cap, rel),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * 写永远落**仓库根**（或 `TP_BENCHMARK_DIR`）。
 *
 * 读可以回落到工作区，写不行：写的目标随「哪个目录碰巧存在」而变，
 * 意味着同一批标注会分散在两处，而两处都不全。人标的 30 条是最贵的那批数据。
 */
export const benchmarkWriteDir = (cap = CAPABILITY): string =>
  process.env.TP_BENCHMARK_DIR ? join(process.env.TP_BENCHMARK_DIR, cap) : join(REPO_ROOT, "benchmark", cap);

/**
 * `scans/<runId>.json`。
 *
 * 契约 §3：Scanner 的产物**独立于 runs/**，可跨运行汇总。Scanner 是一个 Penguin skill，
 * 它跑在工作区里，所以先看工作区，再看仓库根。
 */
export function scanPath(runId: string, workspace?: string): string | undefined {
  const roots = [
    process.env.TP_SCANS_DIR,
    join(workspace ?? defaultWorkspace(), "scans"),
    join(REPO_ROOT, "scans"),
  ].filter(Boolean) as string[];
  for (const r of roots) {
    const p = join(r, `${runId}.json`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

const readJson = <T>(p: string): T | undefined =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;

/* ── 这次运行的用例 ───────────────────────────────────────────────────── */

interface AuditCase {
  id: string;
  storyId?: string;
  title: string;
  steps?: string[];
  expected?: string;
  designMethod?: string;
  covers?: string[];
  /** `run_pipeline` 写的判重三元组。业务规则 1 说的就是它。 */
  key?: string;
}

/**
 * 一次运行的用例，**磁盘优先**。
 *
 * 磁盘那份是原件（跨清库、跨实例都在）；库里那份是为了和决定 join 才存的副本。
 * 审计三个端点回答的都是「这批产物本身怎么样」，所以读原件；原件不在（旧的图运行时那条路
 * 跑出来的运行）再退到库里。
 */
export function casesOf(runId: string): { cases: AuditCase[]; stories: Array<{ id: string }> } | undefined {
  try {
    const p = readRun(workspaceOf(runId), runId);
    return {
      cases: p.bundle.cases as AuditCase[],
      stories: (p.bundle.stories ?? []) as Array<{ id: string }>,
    };
  } catch {
    return undefined; // 磁盘上没有：旧的图运行时那条路跑出来的运行，落到库里那份
  }
}

/** 库里那份（异步，因为 outputStore 是异步接口）。 */
export async function casesFromStore(runId: string): Promise<AuditCase[]> {
  const g = (await outputStore.get(runId, "gate").catch(() => undefined)) as
    | { cases?: AuditCase[] }
    | undefined;
  return g?.cases ?? [];
}

async function batchCases(runId: string): Promise<AuditCase[]> {
  const disk = casesOf(runId);
  if (disk?.cases.length) return disk.cases;
  return casesFromStore(runId);
}

/* ── ① GET /api/audit/:runId/calibration ──────────────────────────────── */

interface GoldItem {
  id: string;
  title: string;
  story?: string;
  heldOut?: boolean;
  match?: { anyOf?: string[]; allOf?: string[]; assertAnyOf?: string[] };
}
interface GoldChecklist {
  id: string;
  items: GoldItem[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** 关键词重合度。匹配不上时用它挑「最该拿来问人的那一条」——问一条毫不相干的用例是浪费人。 */
function overlap(item: GoldItem, c: AuditCase): number {
  const body = norm([c.title, ...(c.steps ?? []), c.expected ?? ""].join(" "));
  const keys = [...(item.match?.anyOf ?? []), ...(item.match?.allOf ?? []), ...(item.match?.assertAnyOf ?? [])];
  const hit = keys.filter((k) => body.includes(norm(k))).length;
  // 清单项标题本身的字也算——`match` 写得稀的项，靠它才排得出先后。
  const titleHit = norm(item.title)
    .split(/[\s,，。/·、]+/)
    .filter((w) => w.length > 1 && body.includes(w)).length;
  return hit * 10 + titleHit;
}

/**
 * κ 只在样本够大时才报。统计本身（`cohensKappa`，harness-core）对任何 n 都有定义，
 * 但一个 n=3 的 κ 是噪声，不是测量——这是**展示**上的门槛，所以放在这里而不放进统计里。
 */
export const KAPPA_MIN_N = 10;

export const SAMPLE_SIZE = 30;

/**
 * 校准样本：30 条，按故事分层，尽量一半 `heldOut`。
 *
 * 分层的理由和抽样量的理由是同一个（架构 §5 / `src/lib/audit.ts` 顶部）：人标的是**样本**，
 * 不是全量。而样本要能代表这批产物，就不能全落在同一条故事上——一次运行里某一条故事
 * 常常独占三分之一的用例，随手取 30 条会把校准变成「关于登录页的校准」。
 *
 * 一条样本 = 一条清单项 × 一条用例。清单项是被判断的对象（人回答「这条用例覆盖了它吗」），
 * 用例是拿来判断的材料，所以每条清单项配一条**最值得问**的用例：机器判它覆盖了的优先
 * （那是要验的正例），其次是重合度最高的（那是最可能的假阴性）。
 */
export function buildSample(gold: GoldChecklist, cases: AuditCase[]): CalibrationItem[] {
  if (!cases.length) return [];

  const pick = (item: GoldItem): AuditCase | undefined => {
    const pool = item.story ? cases.filter((c) => c.storyId === item.story) : cases;
    const from = pool.length ? pool : cases;
    const hit = from.find((c) => covers(item, c));
    if (hit) return hit;
    return [...from].sort((x, y) => overlap(item, y) - overlap(item, x))[0];
  };

  // 按故事分组，再按组轮转取——这就是「分层」。
  const groups = new Map<string, GoldItem[]>();
  for (const g of gold.items) {
    const k = g.story ?? "—";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(g);
  }
  const keys = [...groups.keys()].sort();
  const ordered: GoldItem[] = [];
  for (let i = 0; ordered.length < gold.items.length; i++) {
    let moved = false;
    for (const k of keys) {
      const g = groups.get(k)![i];
      if (g) {
        ordered.push(g);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // 留出与非留出交替着取，好让 30 条里两边都够——留出那一半的用途完全不同（P2），
  // 全取到同一边，界面上那个标记就没有意义了。
  const held = ordered.filter((g) => g.heldOut);
  const open = ordered.filter((g) => !g.heldOut);
  const out: CalibrationItem[] = [];
  for (let i = 0; out.length < SAMPLE_SIZE && (i < held.length || i < open.length); i++) {
    for (const g of [open[i], held[i]]) {
      if (!g || out.length >= SAMPLE_SIZE) continue;
      const c = pick(g);
      if (!c) continue;
      out.push({ caseId: c.id, goldId: g.id, goldTitle: g.title, heldOut: !!g.heldOut });
    }
  }
  return out;
}

export function readLabels(cap = CAPABILITY, ws?: string): HumanLabel[] {
  const p = benchmarkRead("human-labels.json", cap, ws);
  return p ? (readJson<HumanLabel[]>(p) ?? []) : [];
}

export async function calibration(runId: string): Promise<CalibrationPayload> {
  const ws = workspaceOf(runId);
  /**
   * 只认 `gold.json`。
   *
   * 草稿（`gold.draft.json`、`gold.wip.json`…）**不算**——一份还在写的清单拿来抽 30 条让人标，
   * 标完之后清单又变了，那 30 条就既不能算 κ 也不能进基准——P2 说的「考卷不能由考生出」，
   * 反面还有一句：考卷也不能在考试中途改。只有草稿时这里就是 **404**，前端退回假数据并在页头说明白。
   */
  const goldFile = benchmarkRead("gold.json", CAPABILITY, ws);
  const gold = goldFile ? readJson<GoldChecklist>(goldFile) : undefined;
  // **404，不是 500**：`benchmark/<cap>/gold.json` 是 1B 那一路的产物，
  // 它还没写出来是「还没建」，不是「坏了」。
  if (!gold?.items?.length)
    throw new NotFound(
      `还没有 ${CAPABILITY} 的 gold.json（找过 ${benchmarkWriteDir(CAPABILITY)} 与工作区；草稿不算）`,
    );

  const cases = await batchCases(runId);
  if (!cases.length) throw new NotFound(`${runId} 没有可校准的用例`);

  const sample = buildSample(gold, cases);
  const labels = readLabels(CAPABILITY, ws).filter((l) => l.runId === runId);

  // κ：人 vs **那个确定性判官**。样本之外标过的也算进来——人多标了不该被丢掉。
  const byId = new Map(cases.map((c) => [c.id, c]));
  const goldById = new Map(gold.items.map((g) => [g.id, g]));
  const pairs: Array<{ judge: boolean; human: boolean }> = [];
  for (const l of labels) {
    const c = byId.get(l.caseId);
    const g = goldById.get(l.goldId);
    if (!c || !g) continue;
    pairs.push({ human: l.covered, judge: covers(g, c) });
  }
  const k = cohensKappa(pairs);
  return { sample, labels, ...(k.n >= KAPPA_MIN_N ? { kappa: k.kappa } : {}) };
}

/* ── ② GET /api/audit/:runId/scan ─────────────────────────────────────── */

export function scan(runId: string): ScanReport {
  const p = scanPath(runId, workspaceOf(runId));
  // 没跑过 Scanner 就是没跑过。**404**——一个 500 会让人以为审计坏了，
  // 而实际上只是还没有人对这次运行跑过 `testpilot-scanner`。
  if (!p) throw new NotFound(`还没有 ${runId} 的审计报告（scans/${runId}.json）`);
  const report = readJson<ScanReport>(p);
  // 读到了却读不动 —— 这是「建了但坏了」，让它抛成 500。
  if (!report || !Array.isArray(report.findings))
    throw new Error(`${p} 不是一份 ScanReport（缺 findings）`);
  return report;
}

/* ── ③ GET /api/audit/:runId/diff ─────────────────────────────────────── */

/**
 * 用例的三元组键（`docs/archive/spec/02` §6 业务规则 1：判重按「覆盖哪条迁移 / 哪组参数 / 断言什么」）。
 *
 * **不用 caseId 对**。id 是 `S-01-3-有效登录后个人面板显示欢迎用户名` 这种从标题现生成的字符串：
 * 换一次措辞它就变了，于是同一条用例会同时算作「消失了一条」和「新增了一条」——
 * 一份把改写读成增删的差异表，比没有差异表更糟。
 */
export function tripleKey(c: AuditCase): string {
  if (c.key) return c.key;
  const covers = (c.covers ?? []).slice().sort().join(",");
  return [covers || c.storyId || "", c.designMethod ?? "", norm(c.expected ?? "")].join("|");
}

/** 上一个「有已批准决定的 run」。没有就是没有——第一批的 `added` 是全部。 */
export async function previousApproved(
  runId: string,
): Promise<{ runId: string; cases: AuditCase[] } | undefined> {
  const rows = outputStore
    .listRuns(200)
    .filter((r) => String(r.id) !== runId)
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  for (const r of rows) {
    const id = String(r.id);
    const approved = new Set(
      listReviewDecisions(id)
        .filter((d) => d.decision === "approved")
        .map((d) => d.caseId),
    );
    if (!approved.size) continue;
    const all = await batchCases(id);
    const cases = all.filter((c) => approved.has(c.id));
    if (cases.length) return { runId: id, cases };
  }
  return undefined;
}

export async function diff(runId: string): Promise<DiffPayload> {
  const now = await batchCases(runId);
  if (!now.length) throw new NotFound(`${runId} 没有产物可比`);

  const prev = await previousApproved(runId);
  if (!prev) return { added: now.map((c) => c.id), removed: [], changed: [] };

  const before = new Map(prev.cases.map((c) => [tripleKey(c), c]));
  const after = new Map(now.map((c) => [tripleKey(c), c]));

  const added = now.filter((c) => !before.has(tripleKey(c))).map((c) => c.id);
  const removed = prev.cases
    .filter((c) => !after.has(tripleKey(c)))
    .map((c) => ({ caseId: c.id, title: c.title }));

  const changed: DiffPayload["changed"] = [];
  for (const [k, c] of after) {
    const b = before.get(k);
    if (!b) continue;
    const x = b.expected ?? "";
    const y = c.expected ?? "";
    if (x !== y) changed.push({ caseId: c.id, before: { expected: x }, after: { expected: y } });
  }
  return { added, removed, changed };
}

/* ── ④ POST /api/audit/:runId/labels ──────────────────────────────────── */

/**
 * 人标的那些，写进 `benchmark/<cap>/human-labels.json`。
 *
 * 按 `goldId + caseId + runId` 覆盖：`src/lib/audit.ts` 明说界面可以每标一条发一次，
 * 也可以攒够 30 条一次发，后端按键覆盖。
 *
 * **`heldOut: true` 的同时复制一份到 `held-out/`**（架构 §3 P2）。复制而不是移动：
 * 那一份是给 `score_run` / `paired_eval` 用的、对 Optimizer 只读的副本，
 * 而审计台自己要能读回全部标注来显示进度——两个用途，两个位置。
 */
export function appendLabels(
  runId: string,
  incoming: HumanLabel[],
  cap = CAPABILITY,
): { total: number; heldOut: number; path: string } {
  if (!Array.isArray(incoming)) throw new Error("body 要是一个 HumanLabel[]");
  const ws = workspaceOf(runId);
  const dir = benchmarkWriteDir(cap);
  mkdirSync(dir, { recursive: true });

  const key = (l: HumanLabel) => `${l.goldId}|${l.caseId}|${l.runId}`;
  const merged = new Map(readLabels(cap, ws).map((l) => [key(l), l]));
  const at = new Date().toISOString();
  for (const raw of incoming) {
    const l: HumanLabel = {
      goldId: String(raw.goldId),
      caseId: String(raw.caseId),
      // 路径上的 runId 是权威：界面可能从上一批的样本里带过来一个旧的。
      runId: raw.runId ? String(raw.runId) : runId,
      covered: !!raw.covered,
      by: raw.by ? String(raw.by) : "human",
      at: raw.at ? String(raw.at) : at,
      heldOut: !!raw.heldOut,
    };
    if (!l.goldId || !l.caseId) throw new Error("每条标注都要有 goldId 与 caseId");
    merged.set(key(l), l);
  }
  const all = [...merged.values()];
  const path = join(dir, "human-labels.json");
  writeFileSync(path, JSON.stringify(all, null, 2));

  const held = all.filter((l) => l.heldOut);
  mkdirSync(join(dir, "held-out"), { recursive: true });
  writeFileSync(join(dir, "held-out", "human-labels.json"), JSON.stringify(held, null, 2));

  return { total: all.length, heldOut: held.length, path };
}


/* ── 门禁记录 ─────────────────────────────────────────────────────────── */

/** `runs/<runId>/holds.jsonl` 的一行：hook 拒绝了一次写入，被哪道门拦的。 */
export interface Hold {
  at: string;
  hook: string;
  gate: string;
  reason?: string;
  [k: string]: unknown;
}

/**
 * 一次运行被门禁拦了几次、被哪道门拦的。
 *
 * 借 commerce-agents 的 `ToolOutcome.blocked`：拦下是结果不是错误，所以要数。这个数是
 * 模型撞门禁次数的直接度量——它试了几次没有出处就写用例、没读材料就写、给自己盖批准章。
 * 没有 holds.jsonl 就是零次，**不是**错误：一次干净的运行本来就该一次都没被拦。
 */
export function holdsOf(runId: string): { runId: string; total: number; byGate: Record<string, number>; holds: Hold[] } {
  const dir = resolveRunDir(workspaceOf(runId), runId);
  const p = dir ? join(dir, "holds.jsonl") : undefined;
  const holds: Hold[] = [];
  if (p && existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        holds.push(JSON.parse(line) as Hold);
      } catch {
        // 一行坏掉的记录不该让整份计数读不出来。
      }
    }
  }
  const byGate: Record<string, number> = {};
  for (const h of holds) byGate[h.gate ?? "?"] = (byGate[h.gate ?? "?"] ?? 0) + 1;
  return { runId, total: holds.length, byGate, holds };
}
