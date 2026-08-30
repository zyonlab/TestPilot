import { db, newId } from "./db.js";

/**
 * 测试数据集：一张有名字的表，绑给用例之后一行跑一次。
 *
 * 在这之前，数据只有两个去处，两个都不对：
 *   · **写死在步骤里**（`"John"` / `"Doe"`）——换个环境跑不了，跑第二遍撞唯一约束，
 *     而且它进了版本库；
 *   · 塞进环境变量的数组里（`dataKey` 指向 `env.vars[k]`）——能跑，但没有名字、没有列、
 *     没有界面，只能手改 JSON，而且和「这个环境的配置」混在同一口袋里。
 *
 * 所以给它一个一等的位置。四条设计取自 E2E 测试数据的通行做法，每一条都对着一个
 * 这个仓库真吃过的亏：
 *
 * ① **导入要先预览再落库。** 一份列名解析错的数据集，症状不是报错，是二十分钟后
 *    一批「断言没通过」——而错的是数据不是产品。
 *
 * ② **像密钥的列要拦下来。** 数据集是要进版本库的，密钥不能。这条和「凭证不许写进
 *    步骤」是同一条规矩，只是换了个入口。
 *
 * ③ **会落库的列要能标唯一。** 「跑第二遍撞唯一约束」是 E2E 最常复发的一种失败，
 *    而它每次看起来都像产品坏了。标了唯一的列，运行时给它追加一个这次运行独有的后缀。
 *    这不是替代清理（`postSteps`），是它的另一半：清理管「跑完还原」，唯一管
 *    「清理失败时也别互相踩」。
 *
 * ④ **引用的列必须校验。** `${row.emial}` 现在会原样留在步骤里——一个看起来像
 *    占位符的字符串被当成字面量输进表单，没有任何一层会喊。
 */

const cols = new Set(
  (db.prepare("PRAGMA table_info(datasets)").all() as { name: string }[]).map((r) => r.name),
);
if (!cols.size)
  db.exec(`CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    columnsJson TEXT NOT NULL DEFAULT '[]',
    rowsJson TEXT NOT NULL DEFAULT '[]',
    uniqueColsJson TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL
  )`);

export type DataRow = Record<string, string>;

export interface Dataset {
  id: string;
  projectId: string;
  /** 用例通过 `dataKey` 引这个名字。项目内唯一。 */
  name: string;
  columns: string[];
  rows: DataRow[];
  /**
   * 跑的时候要加运行独有后缀的列。
   *
   * 只对**会落进被测产品**的值有意义（用户名、邮箱、单号）。加后缀会改变值，
   * 所以不能默认全开——一个把密码也加了后缀的数据集，每一行都登不上去。
   */
  uniqueCols: string[];
  createdAt: string;
}

interface Row {
  id: string;
  projectId: string;
  name: string;
  columnsJson: string;
  rowsJson: string;
  uniqueColsJson: string;
  createdAt: string;
}
const toDataset = (r: Row): Dataset => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
  columns: JSON.parse(r.columnsJson || "[]") as string[],
  rows: JSON.parse(r.rowsJson || "[]") as DataRow[],
  uniqueCols: JSON.parse(r.uniqueColsJson || "[]") as string[],
  createdAt: r.createdAt,
});

export const listDatasets = (projectId: string): Dataset[] =>
  (
    db
      .prepare("SELECT * FROM datasets WHERE projectId=? ORDER BY name")
      .all(projectId) as Row[]
  ).map(toDataset);

export const getDataset = (projectId: string, name: string): Dataset | undefined => {
  const r = db
    .prepare("SELECT * FROM datasets WHERE projectId=? AND name=?")
    .get(projectId, name) as Row | undefined;
  return r ? toDataset(r) : undefined;
};

export function saveDataset(input: {
  projectId: string;
  name: string;
  rows: DataRow[];
  uniqueCols?: string[];
}): Dataset {
  const columns = [...new Set(input.rows.flatMap((r) => Object.keys(r)))];
  const existing = getDataset(input.projectId, input.name);
  const d: Dataset = {
    id: existing?.id ?? newId("ds"),
    projectId: input.projectId,
    name: input.name,
    columns,
    rows: input.rows,
    uniqueCols: (input.uniqueCols ?? existing?.uniqueCols ?? []).filter((c) => columns.includes(c)),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO datasets (id,projectId,name,columnsJson,rowsJson,uniqueColsJson,createdAt)
     VALUES (@id,@projectId,@name,@columnsJson,@rowsJson,@uniqueColsJson,@createdAt)
     ON CONFLICT(id) DO UPDATE SET name=@name, columnsJson=@columnsJson, rowsJson=@rowsJson,
       uniqueColsJson=@uniqueColsJson`,
  ).run({
    ...d,
    columnsJson: JSON.stringify(d.columns),
    rowsJson: JSON.stringify(d.rows),
    uniqueColsJson: JSON.stringify(d.uniqueCols),
  });
  return d;
}

export const deleteDataset = (id: string): void => {
  db.prepare("DELETE FROM datasets WHERE id=?").run(id);
};

/* ---- 导入 ---- */

/**
 * 认出这段文本是 CSV 还是 JSON，并解析成行。
 *
 * 不问用户「这是什么格式」：他手上有什么就粘什么，而两种格式的区别机器一眼能看出来。
 * 多问一个问题，就多一个答错的机会。
 */
export function parseRows(text: string): { rows: DataRow[]; format: "json" | "csv" } {
  const t = text.trim();
  if (!t) throw new Error("粘进来的内容是空的");
  if (t.startsWith("[") || t.startsWith("{")) {
    const parsed = JSON.parse(t) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const rows = arr.map((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r))
        throw new Error(`第 ${i + 1} 行不是一个对象——数据集的每一行要有列名`);
      return Object.fromEntries(
        Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, v == null ? "" : String(v)]),
      );
    });
    return { rows, format: "json" };
  }
  return { rows: parseCsv(t), format: "csv" };
}

/**
 * CSV 解析。带引号的字段要认，因为地址和姓名里就是有逗号——
 * 一个按逗号硬切的解析器会把「北京市, 朝阳区」切成两列，而且不报错。
 */
export function parseCsv(text: string): DataRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const table = rows.filter((r) => r.some((c) => c.trim()));
  if (table.length < 2) throw new Error("CSV 至少要有一行表头和一行数据");
  const header = table[0]!.map((h) => h.trim());
  if (new Set(header).size !== header.length) throw new Error("表头里有重名的列");
  return table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/* ---- 校验 ---- */

/** 看起来像密钥的列名。数据集要进版本库，这些不能。 */
const SECRETISH = /password|passwd|pwd|secret|token|apikey|api_key|credential|私钥|密码|口令/i;

export interface DatasetWarning {
  kind: "secretish" | "empty" | "duplicate";
  column?: string;
  message: string;
}

/**
 * 导入前的体检。**只警告，不拦**——判断一列是不是密钥，最终要人来看；
 * 一个会自作主张拒收的导入，遇到一个叫 `password_hint` 的合法列就把人挡死了。
 */
export function inspectRows(rows: DataRow[]): DatasetWarning[] {
  const out: DatasetWarning[] = [];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  for (const c of columns)
    if (SECRETISH.test(c))
      out.push({
        kind: "secretish",
        column: c,
        message: `「${c}」看起来是凭证。数据集会跟着导出的工程进版本库——凭证请放密钥库，步骤里用 \${secret.${c}}`,
      });
  for (const c of columns)
    if (rows.every((r) => !String(r[c] ?? "").trim()))
      out.push({ kind: "empty", column: c, message: `「${c}」整列都是空的` });
  const seen = new Set<string>();
  for (const r of rows) {
    const k = JSON.stringify(r);
    if (seen.has(k)) {
      out.push({ kind: "duplicate", message: "有完全重复的行——它们会让同一条用例跑两遍一样的输入" });
      break;
    }
    seen.add(k);
  }
  return out;
}

/** 一段文本里引用了数据集的哪几列。`${row.x}` 与 `${row}`。 */
export function referencedColumns(texts: string[]): { columns: string[]; whole: boolean } {
  const columns = new Set<string>();
  let whole = false;
  for (const t of texts)
    for (const m of t.matchAll(/\$\{row(?:\.([A-Za-z0-9_]+))?\}/g)) {
      if (m[1]) columns.add(m[1]);
      else whole = true;
    }
  return { columns: [...columns], whole };
}

/**
 * 用例引的列，数据集有没有。
 *
 * 这是这一层最该有的检查：`${row.emial}` 现在会**原样留在步骤里**——
 * 那串字会被当成字面量输进表单，而没有任何一层会喊一声。
 */
export function checkBinding(
  steps: string[],
  dataset: Dataset | undefined,
): { missing: string[]; unused: string[]; ok: boolean } {
  const { columns } = referencedColumns(steps);
  if (!dataset) return { missing: columns, unused: [], ok: columns.length === 0 };
  const missing = columns.filter((c) => !dataset.columns.includes(c));
  const unused = dataset.columns.filter((c) => !columns.includes(c));
  return { missing, unused, ok: missing.length === 0 };
}

/**
 * 给一行加上这次运行独有的后缀。
 *
 * 只动标了唯一的列。后缀短而可读（`-r7k2`），因为它会出现在被测产品的数据里，
 * 而那些数据事后是要有人去看、去清理的——一串 uuid 谁也认不出它属于哪次运行。
 */
export function uniquify(row: DataRow, uniqueCols: string[], runSuffix: string): DataRow {
  if (!uniqueCols.length) return row;
  const out = { ...row };
  for (const c of uniqueCols) {
    const v = out[c];
    if (v === undefined || v === "") continue;
    // 邮箱要插在 @ 前面，否则域名被破坏，产品会当成格式错误拒收。
    const at = v.indexOf("@");
    out[c] = at > 0 ? `${v.slice(0, at)}-${runSuffix}${v.slice(at)}` : `${v}-${runSuffix}`;
  }
  return out;
}

/** 这次运行的后缀。短、可读、同一次运行内稳定。 */
export const runSuffix = (seed = Date.now()): string => `r${seed.toString(36).slice(-4)}`;
