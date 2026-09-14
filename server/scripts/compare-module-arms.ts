/**
 * 以参照臂为基准，给每一条臂的模块规划打分（docs/v3/24 §5）。
 *
 * 基准是 `claude-modules.json` / `claude-stories.json`——我作为规划者亲手写的那一份，
 * 2026-09-11 机检结果是「错 0 · 警 1」。它不是满分答案，只是**目前已知最好的那一份**：
 * 它自己也没过扇出线（1.35 < 1.5）。所以这里报的是差距，不是排名。
 *
 * 用法：--ref <前缀> --arm 名字=modules.json[,stories.json] [--arm ...]
 */
import { readFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
const { checkModulePlan } = await import("@testpilot/harness-testing/domain");
const root = resolve(import.meta.dirname, "../..");
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const many = (k: string) => process.argv.flatMap((a, i) => (a === `--${k}` ? [process.argv[i + 1]!] : []));

function sectionsOf(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const n = readFileSync(resolve(f), "utf8").split("\n").filter((l) => /^##\s+/.test(l)).length;
    for (let i = 1; i <= n; i++) out.push(`${basename(f)}#${i}`);
  }
  return out;
}
/**
 * 材料从命令行来，不从代码里来。
 *
 * 这里原本写死 `fixtures/hyperliquid-mainnet/materials` 那两份——于是换一条臂、换一份观察，
 * 「材料覆盖」这一列就悄悄在拿另一份材料的段号去核对，算出来的 14/21 与 0/21 都是假的。
 * 量具自己带着一个产品的路径，就只能量那个产品。
 */
const materials = many("material").map((p) => resolve(p));
const sections = sectionsOf(materials);

type Mod = { id: string; parentId?: string | null; evidence?: string[] };
type Story = { id: string; moduleIds?: string[]; acceptance?: Array<string | { text?: string; evidence?: string[] }>; evidence?: string[] };
const text = (a: string | { text?: string }) => (typeof a === "string" ? a : a.text ?? "");

function load(spec: string) {
  const [name, files] = spec.split("=");
  const [modFile, storyFile] = files!.split(",");
  const m = JSON.parse(readFileSync(resolve(modFile!), "utf8"));
  const src = m.parsed ?? m;
  const s = storyFile ? JSON.parse(readFileSync(resolve(storyFile), "utf8")) : src;
  return { name: name!, modules: (src.modules ?? src) as Mod[], outOfScope: src.outOfScope ?? [],
    stories: ((s.parsed ?? s).stories ?? []) as Story[] };
}

function score(arm: ReturnType<typeof load>) {
  const { modules, stories, outOfScope } = arm;
  const findings = checkModulePlan({ modules, stories, sections, outOfScope });
  const parents = new Set(modules.map((m) => m.parentId).filter(Boolean) as string[]);
  const leaves = modules.filter((m) => !parents.has(m.id));
  const acceptance = stories.flatMap((s) => s.acceptance ?? []);
  const claimed = new Set([...modules.flatMap((m) => m.evidence ?? []), ...stories.flatMap((s) => [...(s.evidence ?? []),
    ...(s.acceptance ?? []).flatMap((a) => (typeof a === "string" ? [] : a.evidence ?? []))]),
    ...outOfScope.map((o: { sectionId: string }) => o.sectionId)]);
  const count = (re: RegExp) => acceptance.filter((a) => re.test(text(a))).length;
  /**
   * 一条验收里**下判断的那一半**。
   *
   * 「若 X，用户就会 Y」里的 X/Y 是后果，不是断言本身。第一版把整条正文一起正则，
   * 结果两件事都数错了：写在后果从句里的「可能」被算成推测词（它其实是在说风险），
   * 写了「若标记价缺失，用户无法判断强平风险」的验收被算成清单式（它明明下了判断）。
   * 所以先把后果从句切掉，再判断前半句是不是只说了「显示了什么」。
   */
  const claim = (a: string | { text?: string }) => text(a).split(/[；;]?\s*若/)[0]!;
  const RULE = /不得|必须|应|否则|无法|说明|视为|按|则|一致|不同步|错误|拒绝|保留|不变/;
  return {
    臂: arm.name,
    模块: modules.length, 根: modules.filter((m) => !m.parentId).length, 叶: leaves.length,
    故事: stories.length, 验收: acceptance.length,
    叶扇出: +(stories.length / Math.max(leaves.length, 1)).toFixed(2),
    材料覆盖: `${sections.filter((s) => claimed.has(s)).length}/${sections.length}`,
    /**
     * 一条验收能不能追回出处。
     *
     * 两种写法都算：对象形式的 `evidence[]`，以及**正文里直接引**（「依据 observed-zh.md#5」）。
     * 后者是因为产品里的 `StorySchema.acceptance` 是 `string[]`——对象形式根本过不了那个节点，
     * 只在离线实验里成立。真节点上能做到的只有正文里引，那就按真节点能做到的来数。
     */
    带出处的验收: acceptance.filter((a) => (typeof a !== "string" && (a.evidence?.length ?? 0) > 0) || /[\w-]+\.md#\d+/.test(text(a))).length,
    待确认: count(/待确认/), 冲突线索: count(/冲突/), 推测词: acceptance.filter((a) => /可能|或许|应该会|大概|视情况/.test(claim(a)) && !/待确认/.test(text(a))).length,
    /**
     * **清单式验收**：只说「某某字段显示出来了」，没说这个字段错了会怎样。
     *
     * 机检数不出来的那一半质量，这一列是它的下界近似：一条验收如果只有「显示 / 存在」
     * 而没有任何规范词（不得 / 必须 / 应 / 否则 / 允许），它多半是把界面观察抄了一遍，
     * 而不是从产品规则推出来的判据。数它不是为了排名，是为了不让「验收条数」这一列
     * 单独说话——59 条里有多少是抄的，得说出来。
     */
    清单式: acceptance.filter((a) => /显示|存在|呈现/.test(claim(a)) && !RULE.test(text(a))).length,
    风险种类: new Set(stories.map((st) => (st as { risk?: string }).risk).filter(Boolean)).size,
    错: findings.filter((f) => f.severity === "error").length,
    警: findings.filter((f) => f.severity === "warn").length,
    提示: findings.filter((f) => f.severity === "info").length,
    codes: [...new Set(findings.map((f) => f.code))].join(" "),
  };
}

const refSpec = arg("ref") ?? `参照臂=${join(root, "docs/v3/evidence/module-plan-2026-09-11/claude-modules.json")},${join(root, "docs/v3/evidence/module-plan-2026-09-11/claude-stories.json")}`;
const rows = [score(load(refSpec)), ...many("arm").map((a) => score(load(a)))];
const cols = Object.keys(rows[0]!).filter((c) => c !== "codes");
const w = (c: string) => Math.max(c.length * 2, ...rows.map((r) => String((r as never)[c]).length));
console.log(cols.map((c) => c.padEnd(w(c))).join(" "));
for (const r of rows) console.log(cols.map((c) => String((r as never)[c]).padEnd(w(c))).join(" "));
console.log();
for (const r of rows) console.log(`${r.臂}: ${r.codes || "（无 finding）"}`);
console.log(JSON.stringify(rows));
