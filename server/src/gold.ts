import { benchmarkMetadata } from "./benchmarkCatalog.js";
import { canonicalJSON, type Principal } from '@testpilot/harness-core/run-contracts';
import { createHash } from 'node:crypto';
/**
 * gold 的生命周期（07 T-19）：草稿 → 复核 → 标留出 → 冻结（goldHash）。
 *
 * gold 是**人的交付物**。这里的每次写都是人从界面来的；agent 没有这条路（hook 与 MCP 都没有对应工具）。
 * 冻结不可撤销：冻结即谱系，`goldHash` 写进 README 的 `## goldHash` 段；冻结后再改任何一条都被拒——
 * 真要改，那是新谱系（`newLineage: true`），从头建基线。规则本身在 `benchmark/<cap>/README.md` 与 `00-架构 §3`。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { goldHashOfFile } from "testpilot-mcp/contracts";
const REPO_ROOT = resolve(import.meta.dirname, "../..");

export interface GoldItem {
  id: string;
  title: string;
  ruleFamily?: string;
  split?: "train" | "dev" | "heldout";
  sourceRefs?: string[];
  expected?: string;
  reviewReceipt?: { reviewer: string; at: string; contentHash: string };
  story?: string;
  designMethod?: string;
  expectTier?: number;
  heldOut?: boolean;
  match: Record<string, unknown>;
  /** T-20：挂到路由 / 组件 / 接口路径，代码一动就该复核。 */
  anchors?: string[];
  stale?: boolean;
  /** T-20：为什么该复核（anchor 命中了哪个改动 / 连续几次 unobservable）。 */
  staleReason?: string;
  /** T-20：这条 gold 对应哪些用例（id 或标题），给 unobservable 连击对号用；没有就按标题子串。 */
  cases?: string[];
}
export interface GoldFile {
  id: string;
  reviewPolicy?: "individual-v1";
  items: GoldItem[];
  outOfScope?: string[];
}
export interface GoldState {
  projectId?: string;
  reviewIssues?: string[];
  capability: string;
  archived?: boolean;
  archiveReason?: string;
  dir: string;
  draft: GoldFile | null;
  gold: GoldFile | null;
  /** README 里记的冻结指纹；没有就是没冻结。 */
  frozenHash: string | null;
  /** 当前 gold.json 内容的指纹（与 frozenHash 不同 = 冻结后被改过）。 */
  currentHash: string | null;
  checklist: string[];
}

const capDir = (cap: string, root = REPO_ROOT): string => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cap)) throw new Error(`capability 名不合法：${cap}`);
  const dir = join(root, "benchmark", cap);
  if (!existsSync(dir)) throw new Error(`没有这个基准：benchmark/${cap}`);
  return dir;
};
const readJson = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);

const HASH_LINE = /goldHash:\s*`?([0-9a-f]{16})`?/;

/**
 * `## goldHash` 那一节里孤立的 16 位十六进制串。
 *
 * `freezeGold` 写的是 `goldHash: \`<hash>\``，但仓库里已有的 README 不都是这个措辞：
 * `benchmark/casegen` 写的是「gold.json  sha256 前 16 位：2405209c…」——同一个事实、
 * 另一种写法。解不出来的后果不是显示不好看：`saveGold` 的冻结守卫读的就是它，
 * 于是**一份 README、文档和十条记分板条目都当成已冻结的 gold，可以被接口直接覆盖**。
 *
 * 只在 `## goldHash` 小节里找，且要求 16 位整词——下一行那个 64 位全串不会被误匹配。
 * 小节里没有哈希（binance 写的是一句 `shasum` 命令、local-perp 写的是「尚未人工冻结」）
 * 仍然返回 null，那两个确实没冻结。
 */
const HASH_IN_SECTION = /##\s*goldHash\b([\s\S]*?)(?=\n##\s|$)/;
function hashInGoldHashSection(text: string): string | null {
  const section = HASH_IN_SECTION.exec(text)?.[1];
  return section ? (/\b([0-9a-f]{16})\b/.exec(section)?.[1] ?? null) : null;
}

export function frozenHashOf(dir: string): string | null {
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) return null;
  const text = readFileSync(readme, "utf8");
  const m = HASH_LINE.exec(text) ?? (hashInGoldHashSection(text) ? [null, hashInGoldHashSection(text)!] as unknown as RegExpExecArray : null);
  return m ? m[1] : null;
}

/** 复核清单（`humanReviewChecklist`）：README 里 `## 复核清单` 段的 `- ` 行；没有就用默认三条。 */
function checklistOf(dir: string): string[] {
  const readme = join(dir, "README.md");
  if (existsSync(readme)) {
    const m = /## 复核清单\n([\s\S]*?)(\n## |$)/.exec(readFileSync(readme, "utf8"));
    if (m) {
      const items = m[1].split("\n").filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim());
      if (items.length) return items;
    }
  }
  return ["删掉易变读数（时刻、计数、实时数值、倒计时）", "match 子句至少一个非空且能命中", "heldOut 标一半，留出的不参与调参"];
}

/**
 * T-20：`scripts/gold-stale.mjs --write` 的输出，放在 gold 旁边，**不进 gold.json**（进了就是新谱系）。
 * 这里只把标记合进返回的条目：`stale: true` + `staleReason`。文件不存在就什么都不标。
 */
export interface GoldStaleFile {
  at: string;
  items: Array<{ id: string; reason: "anchor" | "unobservable"; detail: string }>;
}
export function withStale(file: GoldFile | null, dir: string): GoldFile | null {
  if (!file) return null;
  const stale = readJson<GoldStaleFile>(join(dir, "gold.stale.json"));
  if (!stale?.items?.length) return file;
  const marks = new Map<string, string[]>();
  for (const m of stale.items) marks.set(m.id, [...(marks.get(m.id) ?? []), `${m.reason}: ${m.detail}`]);
  return { ...file, items: file.items.map((it) => (marks.has(it.id) ? { ...it, stale: true, staleReason: marks.get(it.id)!.join(" · ") } : it)) };
}

export function readGoldState(cap: string, root = REPO_ROOT): GoldState {
  const dir = capDir(cap, root);
  return {
    capability: cap,
    projectId: benchmarkMetadata(dir).projectId,
    reviewIssues: (() => { const file = withStale(readJson<GoldFile>(join(dir, "gold.json")), dir); return file ? [...validate(file), ...(file.reviewPolicy === "individual-v1" ? reviewedGold(file) : ["individual_review_required"]), ...file.items.filter(i=>i.stale).map(i=>`${i.id}: stale`)] : ["saved_gold_required"]; })(),
    archived: !!benchmarkMetadata(dir).archived,
    archiveReason: benchmarkMetadata(dir).reason,
    dir,
    draft: withStale(readJson<GoldFile>(join(dir, "gold.draft.json")), dir),
    gold: withStale(readJson<GoldFile>(join(dir, "gold.json")), dir),
    frozenHash: frozenHashOf(dir),
    currentHash: existsSync(join(dir, "gold.json")) ? goldHashOfFile(join(dir, "gold.json")) : null,
    checklist: checklistOf(dir),
  };
}

function validate(file: GoldFile): string[] {
  const problems: string[] = [];
  if (!file.id) problems.push("缺 id");
  if (!Array.isArray(file.items) || !file.items.length) problems.push("items 为空");
  const ids = new Set<string>();
  for (const it of file.items ?? []) {
    if (!it.id || !it.title) problems.push(`条目缺 id/title：${JSON.stringify(it).slice(0, 60)}`);
    if (ids.has(it.id)) problems.push(`重复 id：${it.id}`);
    ids.add(it.id);
    const m = it.match ?? {};
    const nonEmpty = Object.values(m).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));
    if (!nonEmpty) problems.push(`${it.id} 的 match 全空——永远 miss`);
  }
  return problems;
}

const itemHash = (item: GoldItem) => { const { reviewReceipt: _receipt, stale: _stale, staleReason: _reason, ...intent } = item; return createHash('sha256').update(canonicalJSON(intent)).digest('hex'); };
function reviewedGold(file: GoldFile): string[] {
  const errors: string[] = [], families = new Map<string,string>();
  for (const item of file.items) {
    if (!item.expected?.trim() || !item.sourceRefs?.length || !item.ruleFamily || !item.split) errors.push(`${item.id}: 缺预期/出处/规则族/数据划分`);
    if (!item.reviewReceipt || item.reviewReceipt.contentHash !== itemHash(item)) errors.push(`${item.id}: 需要逐条人工确认当前版本`);
    if (item.ruleFamily && item.split) { if (families.has(item.ruleFamily) && families.get(item.ruleFamily) !== item.split) errors.push(`${item.ruleFamily}: 规则族不能跨训练/开发/留出集`); families.set(item.ruleFamily,item.split); }
    if (!!item.heldOut !== (item.split === 'heldout')) errors.push(`${item.id}: heldOut 与 split 不一致`);
  }
  return errors;
}

/** 保存复核后的 gold.json。冻结之后拒绝，除非明说是新谱系。 */
export function saveGold(cap: string, file: GoldFile, opts: { newLineage?: boolean; root?: string; actor?: Principal; reviewedItemIds?: string[] } = {}): { path: string; hash: string; heldOut: number } {
  const dir = capDir(cap, opts.root);
  if (benchmarkMetadata(dir).archived) throw new Error("benchmark_archived_read_only");
  const frozen = frozenHashOf(dir);
  const previous = readJson<GoldFile>(join(dir, "gold.json")), draft = readJson<GoldFile>(join(dir, "gold.draft.json"));
  if ([previous?.reviewPolicy,draft?.reviewPolicy,file.reviewPolicy].includes("individual-v1")) {
    if (opts.actor?.kind !== "human") throw new Error("逐条 gold 复核需要人工入口");
    const confirmed = new Set(opts.reviewedItemIds ?? []);
    if ([...confirmed].some(id => !file.items.some(item => item.id === id))) throw new Error("复核条目不在当前清单");
    file = { ...file, reviewPolicy: "individual-v1", items: file.items.map(item => {
      const { reviewReceipt: _untrusted, ...clean } = item; const hash = itemHash(clean), prior = previous?.items.find(p => p.id === item.id)?.reviewReceipt;
      const reviewReceipt = confirmed.has(item.id) ? { reviewer: opts.actor!.id, at: new Date().toISOString(), contentHash: hash } : prior?.contentHash === hash ? prior : undefined;
      return { ...clean, ...(reviewReceipt ? { reviewReceipt } : {}) };
    }) };
  }
  if (frozen && !opts.newLineage) throw new Error(`benchmark/${cap} 已冻结（goldHash ${frozen}）：改任何一条都是新谱系。要改就带 newLineage: true，从头建基线。`);
  const problems = validate(file);
  if (problems.length) throw new Error(`gold.json 不合格：${problems.join("；")}`);
  const path = join(dir, "gold.json");
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  if (frozen && opts.newLineage) unfreeze(dir);
  return { path, hash: goldHashOfFile(path), heldOut: file.items.filter((i) => i.heldOut).length };
}

function unfreeze(dir: string): void {
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) return;
  const text = readFileSync(readme, "utf8");
  // Legacy READMEs store the hash as a bare value inside this section.
  // Clearing only the labelled form leaves those lineages permanently frozen.
  writeFileSync(readme, text.replace(HASH_IN_SECTION, "## goldHash\n\n新谱系，未冻结。\n").replace(HASH_LINE, "goldHash: （新谱系，未冻结）"));
}

/** 冻结：算 sha256 前 16 位，写进 README 的 `## goldHash` 段。不可撤销。 */
export function freezeGold(cap: string, root = REPO_ROOT): { hash: string; readme: string } {
  const dir = capDir(cap, root);
  if (benchmarkMetadata(dir).archived) throw new Error("benchmark_archived_read_only");
  const path = join(dir, "gold.json");
  if (!existsSync(path)) throw new Error(`benchmark/${cap} 还没有 gold.json，先复核再冻结`);
  const file = readJson<GoldFile>(path)!;
  const required = file.reviewPolicy === "individual-v1" || readJson<GoldFile>(join(dir, "gold.draft.json"))?.reviewPolicy === "individual-v1";
  const problems = [...validate(file), ...(required ? reviewedGold(file) : [])];
  if (problems.length) throw new Error(`gold.json 不合格，不能冻结：${problems.join("；")}`);
  if (!file.items.some((i) => i.heldOut)) throw new Error("至少标一条 heldOut 再冻结——留出集是覆盖率不被拟合的唯一办法");
  const hash = goldHashOfFile(path);
  const readme = join(dir, "README.md");
  const stamp = `goldHash: \`${hash}\`（冻结于 ${new Date().toISOString().slice(0, 10)}，${file.items.length} 条，留出 ${file.items.filter((i) => i.heldOut).length} 条）`;
  let text = existsSync(readme) ? readFileSync(readme, "utf8") : `# 基准：${cap}\n`;
  if (HASH_LINE.test(text)) text = text.replace(HASH_LINE, `goldHash: \`${hash}\``);
  else if (/## goldHash/.test(text)) text = text.replace(/## goldHash\n/, `## goldHash\n\n${stamp}\n`);
  else text += `\n## goldHash\n\n${stamp}\n`;
  writeFileSync(readme, text);
  return { hash, readme };
}

/** Trusted evaluator only: no mutation and no model call. */
export function requireFrozenReviewedGold(cap: string, root = REPO_ROOT) {
  const state = readGoldState(cap, root);
  if (!state.gold || !state.frozenHash || state.frozenHash !== state.currentHash || state.gold.reviewPolicy !== 'individual-v1') throw new Error('human_frozen_gold_required');
  const problems = [...validate(state.gold), ...reviewedGold(state.gold)];
  if (problems.length || state.gold.items.some(i => i.stale) || !state.gold.items.some(i => i.heldOut)) throw new Error('reviewed_gold_invalid_or_stale');
  return { gold: state.gold, hash: state.frozenHash };
}

/** A new draft is an unreviewed candidate, never a human decision or a frozen dataset. */
export function createGoldDraft(cap: string, file: GoldFile, projectId: string, root = REPO_ROOT) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cap)) throw new Error('invalid_capability');
  if (file.id !== cap) throw new Error('gold_id_mismatch');
  const errors = validate(file);
  if (errors.length) throw new Error(errors.join('; '));
  const dir = join(root, 'benchmark', cap);
  if (existsSync(dir)) throw new Error('benchmark_already_exists');
  const clean: GoldFile = { ...file, reviewPolicy: 'individual-v1', items: file.items.map(({ reviewReceipt: _receipt, ...item }) => item) };
  mkdirSync(join(root, 'benchmark'), {recursive:true});
  mkdirSync(dir);
  for (const name of ['materials', 'rubric', 'held-out']) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, '.gitkeep'), '');
  }
  writeFileSync(join(dir,'gold.draft.json'), JSON.stringify(clean,null,2)+'\n', {flag:'wx'});
  writeFileSync(join(dir,'catalog.json'), JSON.stringify({projectId,archived:false},null,2)+'\n');
  writeFileSync(join(dir,'README.md'), '# '+cap+'\n\n候选清单，等待人工逐项复核。gold.json 还不存在；冻结之前禁止正式评分。\n');
  return readGoldState(cap,root);
}
