/**
 * 按需取规格段，替掉「随手切 N token」。
 *
 * 这一层解决的是 `design.cases` 里那个盲裁：规格被 `fitToBudget` 按份额掐中间，
 * 掐掉的是**哪一段**没有人知道，掐掉的那一段跟这条故事有没有关系更没有人知道。
 * 一条讲「退出登录」的故事，拿到的可能是被掐得只剩头尾的登录规格——
 * 而产出看起来完全正常，只是少测了几条。
 *
 * 换成检索之后，同一个预算装的是**和这条故事最相关的那几段**，
 * 而没装进去的那些是有名字的（chunkId），可以被追着取。
 *
 * 三个刻意的选择：
 *
 * 1. **不引向量库。** BM25 就够：规格是几千字的结构化文档，不是百万级语料；
 *    而一个要下模型、要建 embedding、要落库的依赖，换来的是这个规模上量不出的提升。
 * 2. **切片按标题层级，不按固定长度。** SWE-agent 量过：切片大小是个可调参数
 *    （30 行 14.3% / 100 行 18.0% / 整文件 12.7%）。标题层级是文档自己给的边界，
 *    比任何一个固定行数都更接近「一个完整的意思」。
 * 3. **有显式关系图。** 2512.12117：62% 的跨文件证据纯向量检索找不到。
 *    「和查询像」找不到「和这一段连着」的那一段——同一条路由、同一段流程。
 *    所以除了相似度还有边，边给邻居加分。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export * from "./fence.js";

/** 一段规格。`tokens` 是粗估——预算只要「够准到不撑爆窗口」就行。 */
export interface SpecChunk {
  id: string;
  docId: string;
  heading: string[];
  text: string;
  tokens: number;
}

export interface SpecEdge {
  from: string;
  /** chunkId（`same-flow`）或一个外部标识：一条路由、一个控件名。 */
  to: string;
  kind: "mentions-route" | "mentions-control" | "same-flow";
}

export interface SpecIndex {
  materialsHash: string;
  chunks: SpecChunk[];
  edges: SpecEdge[];
}

export interface RetrievedChunk extends SpecChunk {
  score: number;
  /** 它为什么进来了：命中查询，还是被邻居带进来的。 */
  why: string;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /** 相关（分数 > 0）但没装进预算的段数。 */
  dropped: number;
  /** 给模型的一句行为指导，不是一句报错。 */
  hint: string;
}

/* --------------------------------------------------------------- 分词与估算 */

/**
 * 粗估 token 数。与 `harness-core/model/budget.ts` 的 `estimateTokens` 同一套算法
 * （CJK 一字一 token，拉丁四字符一 token）——两处算得不一样，预算就对不上。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/**
 * 分词：拉丁按词，CJK 按**二元组**。
 *
 * CJK 不分词的话，「登录」和「登录失败」在字级上共享两个字，会互相拉高分数到没有区分度；
 * 上一个真正的分词器（jieba 一类）是又一个重依赖。二元组是这两者之间那个便宜的中点，
 * 检索质量在这个规模上足够。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.\-/]*/g)) if (m[0].length >= 2) out.push(m[0]);
  // CJK 连续段：段内取二元组（单字段就取那一个字）。
  for (const m of lower.matchAll(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/* ----------------------------------------------------------------- 建索引 */

/** 材料目录里所有像文档的文件。与 `pipeline.ts` 的 `collectMaterials` 同一条规则。 */
export function collectDocs(dir: string): string[] {
  const root = resolve(dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      // `.json` 也收：探索产物（页面 / 控件 / 状态转移）是**运行时观察**，
      // 而锚定要选可执行运行时而不是可能不全的规格（2606.00898：稀疏库 100% 假阳性）。
      // 一份只索引了文档的索引，答不了「这个控件到底存不存在」。
      else if (/\.(md|markdown|txt|json)$/i.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** 材料目录的内容指纹。`meta.json` 的 `materialsHash` 与索引缓存都用它。 */
export function hashMaterials(dir: string): string {
  const h = createHash("sha256");
  for (const p of collectDocs(dir)) {
    h.update(relative(resolve(dir), p));
    h.update("\0");
    h.update(readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** 一段最长多少 token 就该再切。标题下的一大段散文仍然要能被分开取。 */
const MAX_CHUNK_TOKENS = 700;

/**
 * 按标题层级切一份文档。
 *
 * 代码围栏里的 `#` 不是标题——状态机那种 ```text 块里满是井号和箭头，
 * 照字面切会把一张图切成七段没头没尾的东西。
 */
export function chunkDocument(docId: string, text: string): SpecChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: SpecChunk[] = [];
  const stack: string[] = [];
  let buf: string[] = [];
  let heading: string[] = [];
  let fenced = false;
  let n = 0;

  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    // 一段太长就按空行再切，标题路径照抄——它们仍然属于同一节。
    const paras = estimateTokens(body) <= MAX_CHUNK_TOKENS ? [body] : splitByParagraph(body, MAX_CHUNK_TOKENS);
    for (const part of paras) {
      chunks.push({
        id: `${docId}#${++n}`,
        docId,
        heading: [...heading],
        text: part,
        tokens: estimateTokens(part),
      });
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const depth = m[1].length;
      stack.length = Math.min(stack.length, depth - 1);
      while (stack.length < depth - 1) stack.push("");
      stack[depth - 1] = m[2].trim();
      heading = stack.slice(0, depth).filter(Boolean);
      continue;
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

function splitByParagraph(body: string, limit: number): string[] {
  const paras = body.split(/\n\s*\n/);
  const out: string[] = [];
  let cur: string[] = [];
  let tok = 0;
  for (const p of paras) {
    const t = estimateTokens(p);
    if (tok && tok + t > limit) {
      out.push(cur.join("\n\n"));
      cur = [];
      tok = 0;
    }
    cur.push(p);
    tok += t;
  }
  if (cur.length) out.push(cur.join("\n\n"));
  return out;
}

const ROUTE_RE = /(?<![\w.])\/[a-z][\w\-]*(?:\/[\w\-:${}]+)*/gi;
const CONTROL_RE = /`([^`\n]{1,40})`/g;

/** 抽出这一段提到的路由。判据是字面量，不是模型——一条编出来的路由不该建成一条边。 */
export function routesIn(text: string): string[] {
  return [...new Set([...text.matchAll(ROUTE_RE)].map((m) => m[0]))];
}

/**
 * 探索产物里的控件名。
 *
 * 观察材料里控件不写在反引号里，写成 `- button[submit]: Cross` 或
 * `ACTION: click on Open Orders(0)`。所以这一层单独认那两种行——不认的话，
 * 一份 38KB 的观察会一条 `mentions-control` 边都建不出来，而控件正是这份材料
 * 唯一比规格更有权威的东西。
 */
export function observedControlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const listed = /^-\s+(?:[a-z]+(?:\[[^\]]*\])?:\s*)?(.+?)(?:\s*->\s*\S+)?$/i.exec(line.trim());
    if (listed) {
      const v = listed[1].trim();
      if (v && v.length <= 60 && !v.startsWith("/")) out.add(v);
    }
    // 尾巴上的选择器 ` (#bn-tab-1)` 要去掉，控件名里的括号 `Open Orders(0)` 要留下。
    // 分界是「空格 + 以 # . [ 开头的括号组」——不加这条限定，正则会把 `(0)` 一起吃掉。
    const acted = /^ACTION:\s*\w+\s+on\s+(.+?)(?:\s+\((?=[#.[])[^)]*\))?$/.exec(line.trim());
    if (acted) {
      const v = acted[1].trim();
      if (v && v !== "?" && v.length <= 60) out.add(v);
    }
  }
  return [...out];
}

/** 反引号里的短字面量当控件名。`/path` 与形如代码的东西排除掉。 */
export function controlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CONTROL_RE)) {
    const v = m[1].trim();
    if (!v || v.startsWith("/") || /[{}();=]/.test(v)) continue;
    out.add(v);
  }
  return [...out];
}

/** 同一个 H2 下最多连成一张多大的网。再大就不是「同一段流程」了，只是同一份文档。 */
const SAME_FLOW_GROUP_CAP = 24;

export function buildEdges(chunks: SpecChunk[]): SpecEdge[] {
  const edges: SpecEdge[] = [];
  for (const c of chunks) {
    for (const r of routesIn(c.text)) edges.push({ from: c.id, to: r, kind: "mentions-route" });
    const controls = c.heading[0] === "observed" ? observedControlsIn(c.text) : controlsIn(c.text);
    for (const k of controls) edges.push({ from: c.id, to: k, kind: "mentions-control" });
  }
  // same-flow：同一份文档、同一个二级标题下的段互为邻居。
  // 「同一段流程」在 markdown 里没有别的标记，二级标题是文档作者唯一给出的那条分界。
  const groups = new Map<string, SpecChunk[]>();
  for (const c of chunks) {
    const key = `${c.docId}|${c.heading.slice(0, 2).join(" / ")}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  for (const g of groups.values()) {
    if (g.length < 2 || g.length > SAME_FLOW_GROUP_CAP) continue;
    for (const a of g) for (const b of g) if (a.id !== b.id) edges.push({ from: a.id, to: b.id, kind: "same-flow" });
  }
  return edges;
}

/* ------------------------------------------------- 探索产物（运行时观察） */

/**
 * 探索节点吐出来的那份东西，只挑索引用得上的字段。
 *
 * 形状取自 `explore` 节点的产物（`{ text, graph: { states, transitions, unvisited, plan } }`），
 * 也认它被网关包了一层的样子（`{ output: {...} }`）——两种都在磁盘上出现过。
 */
export interface ObservedDoc {
  text?: string;
  graph?: {
    entry?: string;
    states?: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
    transitions?: Array<{
      from: string;
      to: string;
      ok?: boolean;
      action?: { kind?: string; target?: string; selector?: string };
      effect?: { controlsAdded?: string[]; controlsRemoved?: string[]; textAdded?: string[] };
    }>;
    unvisited?: string[];
    plan?: { business?: string; stories?: Array<{ id: string; title: string; priority?: string }> };
  };
}

/** 这份 JSON 像不像一次探索的观察。不像就当普通文本索引，不猜。 */
export function looksObserved(value: unknown): value is ObservedDoc {
  const v = (value as { output?: unknown })?.output ?? value;
  const g = (v as ObservedDoc)?.graph;
  return !!g && (Array.isArray(g.states) || Array.isArray(g.transitions));
}

/**
 * 把一次探索切成可检索的段。
 *
 * **一屏一段、一条转移一段**，不是把 38KB 的 `text` 当一篇文章切。理由是这份材料的
 * 天然单位就是屏和转移：问「登录后面板上有什么」时，要的是那一屏的控件清单，
 * 不是它前后各 300 行的行情数字。
 *
 * 段里刻意**不塞** `text` 那一大坨渲染文本：它含时间戳、价格、倒计时，每次探索都不同，
 * 会让同一个页面的两次观察算出两份完全不同的指纹，也会把检索淹没在数字里。
 * 要原文时按 chunkId 取那一屏。
 */
export function chunkObserved(docId: string, doc: ObservedDoc): SpecChunk[] {
  const g = doc.graph ?? {};
  const chunks: SpecChunk[] = [];
  let n = 0;
  const push = (heading: string[], text: string) => {
    if (!text.trim()) return;
    chunks.push({ id: `${docId}#${++n}`, docId, heading, text, tokens: estimateTokens(text) });
  };

  for (const s of g.states ?? []) {
    push(
      // heading 用 **state id** 而不是 route：同一条路由下常常有好几屏
      // （展开了面板的、登录框弹出来的），route 一样、内容不一样。
      // 拿 route 当名字，三屏在检索结果里长得一模一样，人分不出该看哪一个。
      ["observed", "screen", s.id],
      [
        `SCREEN ${s.id}`,
        s.route ? `ROUTE: ${s.route}` : "",
        s.title ? `TITLE: ${s.title}` : "",
        (s.controls ?? []).length ? "CONTROLS:" : "",
        ...(s.controls ?? []).map((c) => `- ${c}`),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  for (const t of g.transitions ?? []) {
    const act = t.action ?? {};
    push(
      ["observed", "transition", `${t.from} -> ${t.to}`],
      [
        `TRANSITION ${t.from} -> ${t.to}`,
        `ACTION: ${act.kind ?? "?"} on ${act.target ?? "?"}${act.selector ? ` (${act.selector})` : ""}`,
        t.ok === false ? "RESULT: the action did not go through" : "",
        (t.effect?.controlsAdded ?? []).length ? `APPEARED: ${(t.effect?.controlsAdded ?? []).join(" | ")}` : "",
        (t.effect?.controlsRemoved ?? []).length ? `DISAPPEARED: ${(t.effect?.controlsRemoved ?? []).join(" | ")}` : "",
        (t.effect?.textAdded ?? []).length ? `TEXT APPEARED: ${(t.effect?.textAdded ?? []).join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // 没走到的那些路由自成一段：它们是这份观察**说不出话**的地方，
  // 而「探索没到过这一屏」和「这一屏没有那个控件」是完全不同的两件事。
  if ((g.unvisited ?? []).length)
    push(["observed", "not explored"], ["ROUTES NEVER VISITED (nothing was observed there):", ...(g.unvisited ?? []).map((r) => `- ${r}`)].join("\n"));

  if (g.plan?.stories?.length)
    push(
      ["observed", "plan"],
      [
        g.plan.business ? `BUSINESS: ${g.plan.business}` : "",
        "STORIES THE EXPLORER PLANNED:",
        ...g.plan.stories.map((s) => `- ${s.id} ${s.title}${s.priority ? ` (${s.priority})` : ""}`),
      ]
        .filter(Boolean)
        .join("\n"),
    );

  return chunks;
}

/**
 * 一份材料 → 若干段。按后缀分流：`.json` 试着当探索产物读，读不成就当文本。
 *
 * 「读不成就当文本」不是兜底的懒办法：一份 `data.json` 也可能是测试数据、也可能是
 * 别的什么，把它整个当一段文本索引仍然是对的；而把它**当成**一次探索去解，
 * 会造出一堆空的屏和空的转移，那些空段进了检索就是噪音。
 */
export function chunkMaterial(docId: string, raw: string): SpecChunk[] {
  if (/\.json$/i.test(docId)) {
    try {
      const parsed = JSON.parse(raw) as { output?: unknown };
      const inner = (parsed.output ?? parsed) as ObservedDoc;
      if (looksObserved(parsed)) return chunkObserved(docId, inner);
    } catch {
      // 坏掉的 JSON 当文本索引：一份读不动的材料不该让整个索引建不起来。
    }
    return chunkDocument(docId, raw);
  }
  return chunkDocument(docId, raw);
}

export function buildIndexFromDocs(docs: Array<{ docId: string; text: string }>, materialsHash: string): SpecIndex {
  const chunks = docs.flatMap((d) => chunkMaterial(d.docId, d.text));
  return { materialsHash, chunks, edges: buildEdges(chunks) };
}

/** 索引落在哪。契约 §4：`materials/.index/`。 */
export const indexPath = (materialsDir: string): string => join(resolve(materialsDir), ".index", "index.json");

/**
 * 建（或读回）一份索引。
 *
 * 缓存的判据是 `materialsHash`：材料动了就重建。不用 mtime——一次 `git checkout`
 * 会把所有 mtime 推新，而内容一个字没变；反过来，改完再改回来 mtime 也会变。
 */
export function loadOrBuildIndex(materialsDir: string, opts: { rebuild?: boolean } = {}): SpecIndex {
  const dir = resolve(materialsDir);
  const hash = hashMaterials(dir);
  const path = indexPath(dir);
  if (!opts.rebuild) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as SpecIndex;
      if (cached.materialsHash === hash) return cached;
    } catch {
      // 读不回来就重建。一份坏掉的缓存不该让检索失败——它只是一份可以再算一次的东西。
    }
  }
  const docs = collectDocs(dir).map((p) => ({ docId: relative(dir, p), text: readFileSync(p, "utf8") }));
  const index = buildIndexFromDocs(docs, hash);
  mkdirSync(join(dir, ".index"), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2));
  return index;
}

/* ------------------------------------------------------------------ 检索 */

const K1 = 1.2;
const B = 0.75;

/** 被邻居带进来的那一份分数占多少。0 就等于没有关系图；1 会让边压过相关性。 */
const NEIGHBOUR_WEIGHT = 0.3;

export function bm25(index: SpecIndex, query: string): Map<string, number> {
  const qTerms = tokenize(query);
  const docs = index.chunks.map((c) => ({ id: c.id, terms: tokenize(`${c.heading.join(" ")} ${c.text}`) }));
  const N = docs.length || 1;
  const avgdl = docs.reduce((t, d) => t + d.terms.length, 0) / N || 1;

  const df = new Map<string, number>();
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });

  const scores = new Map<string, number>();
  for (const [i, d] of docs.entries()) {
    let s = 0;
    for (const q of new Set(qTerms)) {
      const f = tfs[i].get(q);
      if (!f) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.terms.length) / avgdl)));
    }
    scores.set(d.id, Number(s.toFixed(4)));
  }
  return scores;
}

/**
 * 取最相关的几段，装满预算为止。
 *
 * 装不下的**不截断**，整段留在外面并报出来——截了一半的规格看起来像完整的规格，
 * 这正是 `fitToBudget` 那条路上出的事。
 */
export function retrieve(
  index: SpecIndex,
  query: string,
  budgetTokens: number,
  opts: { chunkIds?: string[] } = {},
): RetrieveResult {
  const byId = new Map(index.chunks.map((c) => [c.id, c]));

  if (opts.chunkIds?.length) {
    const picked: RetrievedChunk[] = [];
    let used = 0;
    let skipped = 0;
    for (const id of opts.chunkIds) {
      const c = byId.get(id);
      if (!c) continue;
      if (used + c.tokens > budgetTokens && picked.length) {
        skipped += 1;
        continue;
      }
      used += c.tokens;
      picked.push({ ...c, score: 0, why: "requested by id" });
    }
    return {
      chunks: picked,
      dropped: skipped,
      hint: skipped
        ? `Loaded ${picked.length} of the ${opts.chunkIds.length} requested sections; ${skipped} did not fit the ${budgetTokens}-token budget. Ask for them separately.`
        : `Loaded ${picked.length} requested section(s).`,
    };
  }

  const base = bm25(index, query);

  // 关系图这一步：和最相关那几段**连着**的段也算数，即使它自己一个查询词都不含。
  // 「62% 的跨文件证据纯向量检索找不到」说的正是这些段。
  const neighbours = new Map<string, Set<string>>();
  const byRoute = new Map<string, Set<string>>();
  for (const e of index.edges) {
    if (e.kind === "same-flow") {
      (neighbours.get(e.from) ?? neighbours.set(e.from, new Set()).get(e.from)!).add(e.to);
    } else {
      (byRoute.get(`${e.kind}:${e.to}`) ?? byRoute.set(`${e.kind}:${e.to}`, new Set()).get(`${e.kind}:${e.to}`)!).add(e.from);
    }
  }
  // 提到同一条路由 / 同一个控件的段互为邻居。查询里出现 `/testlogin` 时，
  // 讲状态机那一段（不含「登录」二字）才进得来。
  for (const set of byRoute.values()) {
    if (set.size > SAME_FLOW_GROUP_CAP) continue;
    for (const a of set) for (const b of set) if (a !== b) (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
  }

  const final = new Map<string, { score: number; why: string }>();
  for (const c of index.chunks) {
    const own = base.get(c.id) ?? 0;
    let bestNeighbour = 0;
    for (const nb of neighbours.get(c.id) ?? []) bestNeighbour = Math.max(bestNeighbour, base.get(nb) ?? 0);
    const boosted = own + NEIGHBOUR_WEIGHT * bestNeighbour;
    final.set(c.id, {
      score: Number(boosted.toFixed(4)),
      why: own > 0 ? "matches the query" : boosted > 0 ? "linked to a matching section" : "no match",
    });
  }

  const ranked = index.chunks
    .map((c) => ({ chunk: c, ...final.get(c.id)! }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));

  const picked: RetrievedChunk[] = [];
  let used = 0;
  const left: string[] = [];
  for (const r of ranked) {
    if (used + r.chunk.tokens > budgetTokens) {
      left.push(r.chunk.id);
      continue;
    }
    used += r.chunk.tokens;
    picked.push({ ...r.chunk, score: r.score, why: r.why });
  }

  return {
    chunks: picked,
    dropped: left.length,
    hint: buildHint(picked.length, left, used, budgetTokens, index.chunks.length, scriptMismatch(query, index)),
  };
}

/** 一段文本里有多少比例是 CJK。用来判语种，不用来判别的。 */
const cjkShare = (text: string): number => {
  const chars = [...text].filter((c) => /\S/.test(c));
  if (!chars.length) return 0;
  return chars.filter((c) => c.charCodeAt(0) > 0x2e80).length / chars.length;
};

/**
 * 一个字都没匹配上时，先问一句：是不是语种对不上。
 *
 * BM25 是**字面**匹配，跨不了语种。而这条流水线上这种情形是常态而不是意外：
 * 故事按 `lang: "zh"` 生成，探索观察却是被测产品自己的英文界面。
 * 那时的「零命中」不是「规格里没有这件事」，是「你在用中文问一份英文材料」——
 * 两者对模型该有的下一步动作完全不同，而一句「没找到」把它们说成了同一件事。
 */
function scriptMismatch(query: string, index: SpecIndex): string | undefined {
  const q = cjkShare(query);
  const corpus = cjkShare(index.chunks.map((c) => c.text).join(" ").slice(0, 20_000));
  if (q > 0.3 && corpus < 0.1) return "The query is in Chinese but the indexed material is in English — matching here is literal, not translated, so ask in the material's language.";
  if (q < 0.1 && corpus > 0.3) return "The query is in English but the indexed material is in Chinese — matching here is literal, not translated, so ask in the material's language.";
  return undefined;
}

/**
 * 截断变成**行为指导**，不是一句道歉。
 *
 * SWE-agent 的做法：模型看到的不该是「内容被截断了」，而是「还有什么、怎么拿」。
 * 前者只能让它照着不完整的东西往下写，后者它能自己补。
 */
function buildHint(
  loaded: number,
  left: string[],
  used: number,
  budget: number,
  total: number,
  scriptMismatch?: string,
): string {
  if (!loaded)
    return (
      `No section of the specification matched this query (${total} sections indexed).` +
      (scriptMismatch ? ` ${scriptMismatch}` : "") +
      ` Work from the story alone, and say so — do not invent specification text.`
    );
  if (!left.length)
    return `Loaded all ${loaded} relevant sections (${used}/${budget} tokens). Nothing relevant was left out.`;
  const shown = left.slice(0, 5).join(", ");
  return (
    `Loaded ${loaded} sections (${used}/${budget} tokens). ${left.length} further relevant section(s) did not fit: ${shown}${left.length > 5 ? ", …" : ""}. ` +
    `They are omitted, not summarised — if what you need is missing, ask for them by chunkId with retrieve_spec({ chunkIds: [...] }) rather than guessing.`
  );
}
