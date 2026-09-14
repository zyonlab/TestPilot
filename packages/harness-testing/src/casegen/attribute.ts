/**
 * 把一句原话定位回它出自哪一份材料。
 *
 * 这是溯源链上唯一一处不能问模型的地方。`source`（这条故事来自哪份文档）此前是模型自己填的
 * 一个字段：它可以缺，可以对，也可以指向一份根本没产出过这条故事的文档，而三种情况在下游
 * 长得一模一样。于是「每份文档都被覆盖到了吗」这个问题，答案来自被问的那一方。
 *
 * 这里改成确定性的字符串定位：材料按 `===== path =====` 分回一份份文档，一句原话属于哪份，
 * 由它在不在那份文本里决定。**代价是它只认得真的原话**——模型转述过的、翻译过的、
 * 概括过的句子都定位不到。这正是想要的：定位不到本身就是一个信号，说明那句"原话"不是原话。
 *
 * 归一化只做空白折叠和大小写，不做同义、不做模糊匹配。一个会"差不多就算"的定位器，
 * 报出来的覆盖率是它自己的宽容度，不是事实。
 */

export interface SourceDoc {
  path: string;
  text: string;
}

/** `spec.compose` 之前，材料把多份文档用这行横幅拼在一起。 */
const BANNER = /^={3,}\s*(.+?)\s*={3,}$/gm;

/**
 * 把拼起来的材料拆回一份份文档。
 *
 * 没有横幅时整份算一个文档，用 `origin` 当名字——而不是叫它"未知来源"：材料确实只有
 * 一份的时候，它的出处是知道的。
 */
export function splitDocuments(text: string, origin = ""): SourceDoc[] {
  const parts = text.split(BANNER);
  if (parts.length < 3) return [{ path: origin.split(", ")[0] || origin || "inline", text }];
  const out: SourceDoc[] = [];
  for (let i = 1; i < parts.length; i += 2)
    out.push({ path: parts[i].trim(), text: (parts[i + 1] ?? "").trim() });
  return out;
}

/**
 * 比较用的形态：折叠空白、统一大小写。
 *
 * 不动标点。中英文引号、全角半角的差别是真实差别——把它们抹平，就等于允许一句
 * 「点击"提交"」冒充材料里的「点击“提交”」，而界面文案的断言恰恰活在这种细节上。
 */
export function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 这句话出自哪份文档。命中多份时返回第一份——重复出现的句子无法区分，硬选一个比编一个好。
 *
 * 太短的片段不定位：两三个字在任何一份文档里都查得到，那样的"命中"只是在报告文档长度。
 */
export function locate(quote: string, docs: SourceDoc[]): string | undefined {
  const q = normalise(quote);
  if (q.length < 6) return undefined;
  return docs.find((d) => normalise(d.text).includes(q))?.path;
}

/** 反过来问：这两段文字里，有没有一段包含另一段。用于把故事的验收标准对上规格的规则。 */
export function overlaps(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (x.length < 6 || y.length < 6) return false;
  return x.includes(y) || y.includes(x);
}
