import { useCallback, useEffect, useState } from "react";
import { Trash2, Upload, AlertTriangle, KeyRound } from "lucide-react";
import { NeedProject } from "@/components/NeedProject";
import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { TopBar } from "@/components/TopBar";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";

/**
 * 测试数据集。
 *
 * 在这之前数据只有两个去处：写死在步骤里（换个环境跑不了，跑第二遍撞唯一约束，
 * 而且进了版本库），或者塞进环境变量的数组（能跑，但没有名字、没有列、没有界面，
 * 只能手改 JSON）。
 *
 * 这一页的形状取自 E2E 测试数据的通行做法，三条：
 *
 * ① **先预览再落库。** 一份列名解析错的数据集，症状不是报错，是二十分钟后一批
 *    「断言没通过」——而错的是数据不是产品。所以预览是必经的一步，不是可选的便利。
 *
 * ② **像凭证的列当场警告。** 数据集会跟着导出的工程进版本库，凭证不能。
 *    只警告不拦：判断一列是不是凭证最终要人来看。
 *
 * ③ **「谁在用它」跟列表一起显示。** 一个不知道被谁用着的数据集，没人敢删。
 */

interface Dataset {
  id: string;
  name: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  uniqueCols: string[];
  usedBy: Array<{ id: string; title: string }>;
}

interface Preview {
  format: "json" | "csv";
  columns: string[];
  rows: Array<Record<string, string>>;
  total: number;
  warnings: Array<{ kind: string; column?: string; message: string }>;
}

export function DatasetsPage() {
  const t = useT();
  const projectId = useStore((s) => s.activeProjectId);
  const [sets, setSets] = useState<Dataset[]>([]);
  const [error, setError] = useState("");

  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [uniqueCols, setUniqueCols] = useState<string[]>([]);
  /** 勾上的才落库。看起来像凭证的默认不在里面。 */
  const [keepCols, setKeepCols] = useState<Set<string>>(new Set());
  /** 哪几列被判成像凭证，以及人明确推翻了哪几个判断。 */
  const [secretish, setSecretish] = useState<Set<string>>(new Set());
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const d = (await fetch(`${API_BASE}/api/projects/${projectId}/datasets`).then((r) => r.json())) as {
        datasets?: Dataset[];
        error?: string;
      };
      if (d.error) return setError(d.error);
      setSets(d.datasets ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 解析但不落库。解析失败要说清楚哪一行错了，而不是「导入失败」。 */
  const doPreview = async (src: string) => {
    setError("");
    setPreview(null);
    if (!src.trim()) return;
    const d = (await fetch(`${API_BASE}/api/datasets/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: src }),
    }).then((r) => r.json())) as Preview & { error?: string };
    if (d.error) return setError(d.error);
    setPreview(d);
    setUniqueCols([]);
    /*
     * 看起来像凭证的列，**默认不勾**。
     *
     * 数据集会跟着导出的工程进版本库——一列 `password` 落进去就是一次凭证泄漏，
     * 而它在界面上看起来只是一列普通数据。要落它得先明确解锁一次：
     * 服务端只是警告（一个叫 `password_hint` 的合法列不该被拒死），
     * 所以「拦」这件事落在这里，而且是可以被人推翻的那种拦。
     */
    const secret = new Set(
      d.warnings.filter((w) => w.kind === "secretish" && w.column).map((w) => w.column as string),
    );
    setSecretish(secret);
    setUnlocked(new Set());
    setKeepCols(new Set(d.columns.filter((c) => !secret.has(c))));
  };

  const commit = async () => {
    if (!preview || !name.trim() || !projectId) return;
    setBusy(true);
    setError("");
    const d = (await fetch(`${API_BASE}/api/projects/${projectId}/datasets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), text, uniqueCols, keepCols: [...keepCols] }),
    }).then((r) => r.json())) as { error?: string };
    setBusy(false);
    if (d.error) return setError(d.error);
    setText("");
    setName("");
    setPreview(null);
    setUniqueCols([]);
    setKeepCols(new Set());
    void load();
  };

  const remove = async (d: Dataset) => {
    if (d.usedBy.length && !window.confirm(t("data.deleteUsed", { n: d.usedBy.length }))) return;
    await fetch(`${API_BASE}/api/datasets/${d.id}`, { method: "DELETE" });
    void load();
  };

  /*
   * 空状态**也要带着页头**——页头挂着同组界面的 tab，守卫分支里把它省掉，
   * 等于这一屏在没选项目时没有出口，人只能回左导航重来一次。
   */
  if (!projectId)
    return (
      <>
        <TopBar title={t("surface.data")} />
        <div className="p-4"><NeedProject /></div>
      </>
    );

  return (
    <>
      <TopBar title={t("surface.data")} hint={t("data.lede")} />
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-4xl space-y-4">
          {/* ---- 导入 ---- */}
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-2">
              <Upload className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[0.8125rem] font-medium">{t("data.importTitle")}</span>
              <span className="text-[0.75rem] text-muted-foreground">{t("data.importHint")}</span>
            </div>
            <textarea
              className="h-28 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[0.75rem]"
              placeholder={"first,last,city\nJohn,Doe,Springfield\nJane,Roe,Madison"}
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              onBlur={(e) => void doPreview(e.target.value)}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button onClick={() => void doPreview(text)} disabled={!text.trim()}>
                {t("data.parse")}
              </Button>
              {preview && (
                <>
                  <input
                    className="w-44 rounded-md border border-border bg-background px-2 py-[0.1875rem] text-[0.75rem]"
                    placeholder={t("data.namePlaceholder")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Button variant="primary" onClick={() => void commit()} disabled={!name.trim() || busy}>
                    {t("data.save")}
                  </Button>
                </>
              )}
            </div>

            {error && <p className="mt-2 text-[0.75rem] text-bad">{error}</p>}

            {preview && (
              <div className="mt-3 space-y-2">
                <div className="text-[0.75rem] text-muted-foreground">
                  {t("data.parsed", {
                    format: preview.format.toUpperCase(),
                    n: preview.total,
                    cols: preview.columns.length,
                  })}
                </div>

                {preview.warnings.map((w, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[0.75rem]",
                      w.kind === "secretish"
                        ? "border-bad bg-bad-soft text-bad"
                        : "border-warn bg-warn-soft text-warn",
                    )}
                  >
                    {w.kind === "secretish" ? (
                      <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>{w.message}</span>
                  </div>
                ))}

                {/* 落库列就在列头上勾。像凭证的那几列勾不动，除非先明确推翻那个判断——
                    「拦下且不可勾」不等于「不许」，它等于「你得说一句这不是凭证」。 */}
                <div className="rounded-md border border-dashed border-border p-2">
                  <div className="mb-1 text-[0.75rem] text-muted-foreground">{t("data.keepHint")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.columns.map((c) => {
                      const locked = secretish.has(c) && !unlocked.has(c);
                      return (
                        <span key={c} className="inline-flex items-center gap-1">
                          <button
                            disabled={locked}
                            title={locked ? t("data.keepLocked") : undefined}
                            onClick={() =>
                              setKeepCols((k) => {
                                const n = new Set(k);
                                n.has(c) ? n.delete(c) : n.add(c);
                                return n;
                              })
                            }
                            className={cn(
                              "rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
                              locked
                                ? "cursor-not-allowed bg-bad-soft text-bad line-through"
                                : keepCols.has(c)
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted text-muted-foreground hover:brightness-95",
                            )}
                          >
                            {c}
                          </button>
                          {secretish.has(c) && !unlocked.has(c) && (
                            <button
                              className="cursor-pointer text-[0.6875rem] text-muted-foreground underline decoration-dotted hover:text-foreground"
                              onClick={() => setUnlocked((u) => new Set(u).add(c))}
                            >
                              {t("data.keepUnlock")}
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <Table columns={preview.columns} rows={preview.rows} total={preview.total} t={t} />

                {/*
                  标唯一：会落进被测产品的列（用户名、邮箱、单号）该标上。
                  「跑第二遍撞已存在」是 E2E 最常复发的一种失败，而它每次看起来都像产品坏了。
                  不默认全开——给密码加后缀会让每一行都登不上去。
                */}
                <div className="rounded-md border border-dashed border-border p-2">
                  <div className="mb-1 text-[0.75rem] text-muted-foreground">{t("data.uniqueHint")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.columns.map((c) => (
                      <button
                        key={c}
                        onClick={() =>
                          setUniqueCols((u) => (u.includes(c) ? u.filter((x) => x !== c) : [...u, c]))
                        }
                        className={cn(
                          "rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
                          uniqueCols.includes(c)
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:brightness-95",
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ---- 已有的 ---- */}
          {sets.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-[0.8125rem] text-muted-foreground">
              {t("data.empty")}
            </p>
          ) : (
            sets.map((d) => (
              <div key={d.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[0.8125rem] font-medium">{d.name}</span>
                  <span className="text-[0.75rem] text-muted-foreground">
                    {t("data.shape", { rows: d.rows.length, cols: d.columns.length })}
                  </span>
                  {d.uniqueCols.map((c) => (
                    <span
                      key={c}
                      title={t("data.uniqueWhy")}
                      className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[0.6875rem] text-primary"
                    >
                      {t("data.uniqueTag", { col: c })}
                    </span>
                  ))}
                  <span className="ml-auto text-[0.75rem] text-muted-foreground">
                    {d.usedBy.length ? t("data.usedBy", { n: d.usedBy.length }) : t("data.usedByNone")}
                  </span>
                  <button
                    onClick={() => void remove(d)}
                    title={t("common.delete")}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-bad"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* 用例名字要列出来：知道被谁用着，才敢改它。 */}
                {!!d.usedBy.length && (
                  <div className="mt-1 truncate text-[0.6875rem] text-muted-foreground">
                    {d.usedBy.map((c) => c.title).join(" · ")}
                  </div>
                )}
                <div className="mt-2">
                  <Table columns={d.columns} rows={d.rows.slice(0, 5)} total={d.rows.length} t={t} />
                </div>
                <p className="mt-1.5 font-mono text-[0.6875rem] text-muted-foreground">
                  {t("data.useIt", { name: d.name, ref: "${row." + (d.columns[0] ?? "col") + "}" })}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function Table({
  columns,
  rows,
  total,
  t,
}: {
  columns: string[];
  rows: Array<Record<string, string>>;
  total: number;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[0.75rem]">
        <thead className="bg-muted/60 text-left text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-2 py-1 font-mono font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              {columns.map((c) => (
                <td key={c} className="max-w-[13.75rem] truncate px-2 py-1" title={r[c]}>
                  {r[c] || <span className="text-muted-foreground/60">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > 8 && (
        <div className="border-t border-border/60 px-2 py-1 text-[0.6875rem] text-muted-foreground">
          {t("data.more", { n: total - 8 })}
        </div>
      )}
    </div>
  );
}
