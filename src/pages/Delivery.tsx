import { useEffect, useState } from "react";
import { Download, FileCode2, GitPullRequest, Workflow, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";

/**
 * 交付：这套用例怎么进到客户已有的仓库与流水线里。
 *
 * 一条纪律贯穿这一页：**只有真的能做的事才有按钮**。导出是实的（服务端已经能产出一个
 * 可独立运行的 Playwright + Midscene 工程），PR / CI / 覆盖回传还没有实现，所以它们
 * 在这里是明确标着「未实现」的说明，而不是一个点下去什么也不发生的按钮。
 * 一个假装能用的交付页，正是"接管质量工程"这件事最不能有的东西。
 */
export function Delivery() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const cases = useStore((s) => s.cases);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");

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
  }, [activeProjectId]);

  if (!activeProjectId) {
    return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;
  }

  const withCode = cases.filter((c) => c.hasCode).length;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-3xl space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
            <Download className="h-4 w-4 text-primary" />
            {t("deliver.exportTitle")}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("deliver.exportHelp")}</p>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
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

          {files.length > 0 && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {files.slice(0, 24).join("\n")}
              {files.length > 24 ? `\n… ${files.length - 24} more` : ""}
            </pre>
          )}
          {error && <p className="mt-2 text-[12px] text-rose-500">{error}</p>}

          <div className="mt-3">
            <Button
              variant="primary"
              onClick={() => {
                window.location.href = `${API_BASE}/api/projects/${activeProjectId}/export`;
              }}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              {t("deliver.download")}
            </Button>
          </div>
        </div>

        {/* Everything below is honest about not existing yet. */}
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
            <GitPullRequest className="h-4 w-4" />
            {t("deliver.prTitle")}
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              {t("deliver.notYet")}
            </span>
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("deliver.prHelp")}</p>
        </div>

        <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
            <Workflow className="h-4 w-4" />
            {t("deliver.ciTitle")}
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              {t("deliver.notYet")}
            </span>
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("deliver.ciHelp")}</p>
          <pre className="mt-2 rounded-lg bg-muted p-2 font-mono text-[11px] text-muted-foreground">
            npx testpilot run --suite=P0 --env=staging --report=junit
          </pre>
        </div>

        <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-muted-foreground">
            <ClipboardList className="h-4 w-4" />
            {t("deliver.backTitle")}
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              {t("deliver.notYet")}
            </span>
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("deliver.backHelp")}</p>
        </div>

        <p className="text-[12px] leading-relaxed text-muted-foreground">{t("deliver.stagesHelp")}</p>
      </div>
    </div>
  );
}
