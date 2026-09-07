import { useEffect, useState } from "react";
import { NeedProject } from "@/components/NeedProject";
import { cn } from "@/lib/cn";
import { Download, FileCode2, GitPullRequest, Workflow, ClipboardList } from "lucide-react";
import { Button, ErrorCard } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { TopBar } from "@/components/TopBar";
import { API_BASE } from "@/lib/base";
import { openCard } from "@/lib/open";

/**
 * 交付：这套用例怎么进到客户已有的仓库与流水线里。
 *
 * 一条纪律贯穿这一页：**只有真的能做的事才有按钮**。导出是实的（服务端已经能产出一个
 * 可独立运行的 Playwright + Midscene 工程），PR / CI / 覆盖回传还没有实现，所以它们
 * 在这里是明确标着「未实现」的说明，而不是一个点下去什么也不发生的按钮。
 * 一个假装能用的交付页，正是"接管质量工程"这件事最不能有的东西。
 */
/**
 * 一串路径画成一棵树。
 *
 * 交出去的是一个仓库，而 `tests/checkout.spec.ts` 这样一串扁平路径读不出层次——
 * 「客户仓库会变成什么样」这个问题，答案本来就是树形的。
 */
function treeLines(paths: string[]): Array<{ text: string; isDir: boolean }> {
  const root: Record<string, unknown> = {};
  for (const p of [...paths].sort()) {
    let node = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      if (leaf) node[part] = null;
      else node = (node[part] ??= {}) as Record<string, unknown>;
    });
  }
  const out: Array<{ text: string; isDir: boolean }> = [];
  const walk = (node: Record<string, unknown>, depth: number) => {
    const keys = Object.keys(node).sort((a, b) => {
      const ad = node[a] !== null;
      const bd = node[b] !== null;
      return ad === bd ? a.localeCompare(b) : ad ? -1 : 1;
    });
    for (const k of keys) {
      const isDir = node[k] !== null;
      out.push({ text: `${"".repeat(depth)}${isDir ? "▸" : ""}${k}${isDir ? "/" : ""}`, isDir });
      if (isDir) walk(node[k] as Record<string, unknown>, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export function Delivery() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const cases = useStore((s) => s.cases);
  const overview = useStore((s) => s.overviews[s.activeProjectId]);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  /** 自检结果。每一条都是服务端查过的事实。 */
  const [checks, setChecks] = useState<
    Array<{
      id: string;
      ok: boolean;
      n?: number;
      detail?: string;
      excludedByDefault?: boolean;
      cases?: Array<{ id: string; title: string }>;
    }>
  >([]);
  /** 连隔离的和断言被改松的一起导出。默认关着。 */
  const [includeAll, setIncludeAll] = useState(false);

  useEffect(() => {
    if (!activeProjectId) return;
    setError("");
    fetch(`${API_BASE}/api/projects/${activeProjectId}/export?format=json`)
      .then((r) => r.json())
      .then((d: { files?: Record<string, string>; error?: string }) => {
        if (d.error) return setError(d.error);
        setFiles(Object.keys(d.files ?? {}));
      })
      .catch((e) => setError((e as Error).message));
    fetch(`${API_BASE}/api/projects/${activeProjectId}/export-preflight`)
      .then((r) => r.json())
      .then((d: { checks?: typeof checks }) => setChecks(d.checks ?? []))
      .catch(() => setChecks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  if (!activeProjectId) {
    return (
      <>
        <TopBar title={t("surface.deliver")} />
        <div className="p-4"><NeedProject /></div>
      </>
    );
  }

  const withCode = cases.filter((c) => c.hasCode).length;
  // 导出的是**已批准**的那一批，不是工作流刚跑出来的候选。这一页此前不说这件事，
  // 于是「0 条用例」和画布上的「用例代码 38」并存，谁也说不清哪个是真的。
  const candidates = overview?.candidates.cases ?? 0;

  return (
    <>
      <TopBar title={t("surface.deliver")} />
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-3xl space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
              <Download className="h-4 w-4 text-primary" />
              {t("deliver.exportTitle")}
            </h3>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("deliver.exportHelp")}</p>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.75rem] text-muted-foreground">
              <span className="rounded bg-muted px-2 py-0.5 font-mono">
                {cases.length} {t("deliver.cases")}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 font-mono">
                {withCode} {t("deliver.withCode")}
              </span>
              {files.length > 0 && (
                <span className="rounded bg-muted px-2 py-0.5 font-mono">
                  {files.length} {t("deliver.files")}
                </span>
              )}
            </div>

            {/* 客户仓库会变成什么样：一棵真的目录树，不是一串扁平路径。
                交出去的是一个仓库，而一串 `tests/foo.spec.ts` 读不出层次。 */}
            {files.length > 0 && (
              <div className="mt-2 max-h-56 overflow-auto rounded-lg bg-muted p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
                {treeLines(files).map((l, i) => (
                  <div key={i} className={cn(l.isDir && "text-foreground")}>
                    {l.text}
                  </div>
                ))}
              </div>
            )}

            {/* 自检清单。每一条都是**已经查过的事实**——不是「记得检查登录带走了没有」
                这种谁都写得出、对读的人却毫无帮助的提醒语。 */}
            {checks.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[0.75rem] font-medium text-muted-foreground">
                  {t("deliver.preflight")}
                </div>
                {checks.map((c) => (
                  <div
                    key={c.id}
                    className={cn(
                      "flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[0.75rem]",
                      c.ok ? "border-border text-muted-foreground" : "border-warn bg-warn-soft text-warn",
                    )}
                  >
                    <span className="mt-[0.0625rem] flex-none">{c.ok ? "✓" : "!"}</span>
                    <span>
                      {t(`deliver.check.${c.id}`, { n: String(c.n ?? 0) })}
                      {c.detail ? ` · ${c.detail}` : ""}
                      {c.excludedByDefault && (c.n ?? 0) > 0 && (
                        <span className="ml-1 opacity-80">{t("deliver.excludedByDefault")}</span>
                      )}
                      {!!c.cases?.length && (
                        <span className="mt-0.5 block font-mono text-[0.6875rem] opacity-80">
                          {c.cases
                            .slice(0, 5)
                            .map((k) => k.title)
                            .join(" · ")}
                          {c.cases.length > 5 ? ` … +${c.cases.length - 5}` : ""}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {error && <ErrorCard className="mt-2" reason={error} />}

            {/*
              0 条用例时按钮不可点，并且说清楚为什么。
              此前它一直可点，点下去拿到的是一个只有骨架、一条测试都没有的 zip——
              而同一屏上就写着「0 条用例」。一个明知会给出空结果却仍然亮着的按钮，
              比一个灰着的按钮更伤人：它让人以为是导出坏了。
            */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                disabled={cases.length === 0}
                onClick={() => {
                  window.location.href = `${API_BASE}/api/projects/${activeProjectId}/export${
                    includeAll ? "?include=all" : ""
                  }`;
                }}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                {t("deliver.download")}
              </Button>
              {/* 隔离的和断言被改松的默认不导出。要它们得说一句——那是一个决定，不是默认。 */}
              <label className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeAll}
                  onChange={(e) => setIncludeAll(e.target.checked)}
                />
                {t("deliver.includeAll")}
              </label>
              {cases.length === 0 && (
                <span className="text-[0.75rem] text-muted-foreground">
                  {candidates
                    ? t("deliver.emptyButCandidates", { n: candidates })
                    : t("deliver.emptyNoCandidates")}
                  {candidates > 0 && (
                    <button className="ml-1 text-primary hover:underline" onClick={() => openCard("review")}>
                      {t("deliver.goReview")} →
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Everything below is honest about not existing yet. */}
          <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
              <GitPullRequest className="h-4 w-4" />
              {t("deliver.prTitle")}
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                {t("deliver.notYet")}
              </span>
            </h3>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("deliver.prHelp")}</p>
          </div>

          <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
              <Workflow className="h-4 w-4" />
              {t("deliver.ciTitle")}
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                {t("deliver.notYet")}
              </span>
            </h3>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("deliver.ciHelp")}</p>
            <pre className="mt-2 rounded-lg bg-muted p-2 font-mono text-[0.6875rem] text-muted-foreground">
              npx testpilot run --suite=P0 --env=staging --report=junit
            </pre>
          </div>

          <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
              <ClipboardList className="h-4 w-4" />
              {t("deliver.backTitle")}
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                {t("deliver.notYet")}
              </span>
            </h3>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("deliver.backHelp")}</p>
          </div>

          <p className="text-[0.75rem] leading-relaxed text-muted-foreground">{t("deliver.stagesHelp")}</p>
        </div>
      </div>
    </>
  );
}
