import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { REPO_ROOT } from "./evalspecs.js";

/**
 * 可以当材料喂进去的文档。
 *
 * `source.spec` 的 `paths` 此前只能在节点参数的 JSON 文本框里手写一个字符串数组。那不是
 * 一件小麻烦：**规格是下游一切的输入**，而选错一个路径不会报错——文件读不到才报错，
 * 路径拼对了但选的是另一份文档，只会在二十分钟后变成一批看起来正常、其实答非所问的用例。
 *
 * 所以让它变成一件可以看着选的事。这里只负责回答"有哪些文件可选"，选哪几份仍然是人的
 * 决定——列出来不等于推荐，也不会有谁替他勾上。
 */

/** 材料只可能是文本。二进制文件列出来只会让人多读一遍再排除掉。 */
const READABLE = /\.(md|mdx|txt|markdown)$/i;

/** 不进去找：这些目录里没有材料，只有噪声。 */
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".data", "coverage", ".next"]);

/** 一次列出来的上限。目录深到这个量级时，问题已经不是选不了了。 */
const MAX = 400;

export interface MaterialFile {
  /** 相对仓库根，正是 `paths` 要填的形式。 */
  path: string;
  bytes: number;
}

function walk(dir: string, out: MaterialFile[], depth: number): void {
  if (out.length >= MAX || depth > 6) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 读不动的目录跳过，不让它中断整次列举
  }
  for (const name of entries.sort()) {
    if (out.length >= MAX) return;
    if (name.startsWith(".") || SKIP.has(name)) continue;
    const full = resolve(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out, depth + 1);
    else if (READABLE.test(name)) out.push({ path: relative(REPO_ROOT, full), bytes: st.size });
  }
}

/**
 * 仓库里可以当材料用的文档。
 *
 * 从 `docs/` 和 `fixtures/` 开始找，而不是整个仓库：源码里的 README 不是产品规格，
 * 把它们混进来会让这份列表变成一个需要先过滤才能用的东西。
 */
export function listMaterials(): { files: MaterialFile[]; truncated: boolean } {
  const files: MaterialFile[] = [];
  for (const root of ["docs", "fixtures"]) walk(resolve(REPO_ROOT, root), files, 0);
  return { files, truncated: files.length >= MAX };
}
