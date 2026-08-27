import { useEffect, useState } from "react";
import { Globe, ServerCog } from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { API_BASE, IS_OVERRIDDEN, resetApiBase } from "@/lib/base";
import { useInSection } from "@/components/SectionNav";

export function TopBar({ actions }: { actions?: React.ReactNode }) {
  const t = useT();
  // Hosted inside a section, the page's own breadcrumb would be the second header on
  // screen — but its `actions` are the page's only controls, and dropping the whole bar
  // took "新建项目" off the projects page entirely. So the identity half steps aside and
  // the actions stay.
  const inSection = useInSection();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);

  // Which gateway this tab is driving. Only shown when it is not the usual one — during a
  // self-test two instances are up, and "which one am I looking at" stops being obvious.
  const [instance, setInstance] = useState("");
  useEffect(() => {
    if (!IS_OVERRIDDEN) return;
    void fetch(`${API_BASE}/api/health`)
      .then((r) => r.json())
      .then((d: { instance?: string }) => setInstance(d.instance ?? "?"))
      .catch(() => setInstance("unreachable"));
  }, []);

  const active = projects.find((p) => p.id === activeId);
  const label = active ? active.name : t("common.noProjectSelected");

  if (inSection) {
    if (!actions) return null;
    return (
      <div className="flex items-center justify-end gap-2 border-b border-border px-3 py-2">
        {actions}
      </div>
    );
  }

  return (
    <header className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2.5">
      {/* The project switcher now lives in the sidebar. Here it's a plain breadcrumb. */}
      <div className="flex items-center gap-1.5 px-1 text-sm">
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{label}</span>
      </div>
      {IS_OVERRIDDEN && (
        <button
          onClick={resetApiBase}
          title={t("topbar.backToDefault")}
          className="flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
        >
          <ServerCog className="h-3.5 w-3.5" />
          {instance || "…"} · {API_BASE.replace(/^https?:\/\//, "")}
        </button>
      )}
      <div className="ml-auto flex gap-2">{actions}</div>
    </header>
  );
}
