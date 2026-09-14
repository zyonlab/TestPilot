import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { Drawer } from "@/components/overlay";
import { Markdown } from "@/components/Markdown";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";

/**
 * 规格材料：多份文档用侧栏 tab 切换，正文按 markdown 预览。
 *
 * 这是下游一切的输入——故事从它来，用例从故事来，断言引用的界面文案要能在它里面查到。
 * 而它在界面上此前的样子是一行路径，躺在 `source.spec` 的参数框里。**路径不是阅读方式**：
 * 一条用例看着不对时，第一件想做的事就是回去读那一段原文，而这件事以前只能去翻仓库。
 *
 * 读的是**那次运行真正拿到的文本**，不是磁盘上现在的文件。文件后来改过是常有的事，
 * 而运行是拿当时那份跑的——拿今天的文件解释昨天的产物，正是追溯最容易骗人的地方。
 */
export function SpecDrawer({ wfRunId, onClose }: { wfRunId: string; onClose: () => void }) {
  const t = useT();
  const [docs, setDocs] = useState<Array<{ name: string; text: string }>>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!wfRunId) return;
    fetch(`${API_BASE}/api/wf/runs/${wfRunId}/nodes/spec`)
      .then((r) => r.json())
      .then((d: { output?: { text?: string; origin?: string }; error?: string }) => {
        if (d.error || !d.output?.text) return setError(d.error ?? t("spec.none"));
        setDocs(split(d.output.text, d.output.origin ?? ""));
      })
      .catch((e) => setError((e as Error).message));
  }, [wfRunId, t]);

  const doc = docs[active];

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-1.5">
          <FileText className="h-4 w-4 text-primary" />
          {t("spec.title")} · {docs.length || "—"}
        </span>
      }
      resizeKey="spec"
      /* 物料正文抽屉：整屏打开，收合按钮可切回常规宽度。 */
      fullscreen
      defaultWidth={900}
      tabs={docs.map((d, i) => ({
        id: d.name,
        label: d.name.split("/").pop() ?? d.name,
        active: i === active,
        onSelect: () => setActive(i),
      }))}
    >
      {error && <div className="p-4 text-[0.8125rem] text-bad">{error}</div>}
      {doc && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[0.75rem] text-muted-foreground">
            <span className="font-mono">{doc.name}</span>
            <span className="rounded bg-ok-soft px-1.5 py-0.5 text-ok">{t("spec.wasInput")}</span>
            <span className="ml-auto font-mono">{doc.text.length} chars</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <Markdown text={doc.text} />
          </div>
          <p className="border-t border-border px-4 py-2 text-[0.75rem] leading-relaxed text-muted-foreground">
            {t("spec.footnote")}
          </p>
        </>
      )}
    </Drawer>
  );
}

/**
 * Split the run's captured material back into files.
 *
 * The spec node concatenates its inputs with a `===== path =====` banner between them, so
 * the file boundaries survive in the text itself. When there is no banner — a single file,
 * or an older run — the whole thing is one document named after the origin rather than
 * being silently presented as unattributed text.
 */
function split(text: string, origin: string): Array<{ name: string; text: string }> {
  const parts = text.split(/^={3,}\s*(.+?)\s*={3,}$/m);
  if (parts.length < 3) return [{ name: origin || "spec", text: text.trim() }];
  const out: Array<{ name: string; text: string }> = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ name: parts[i], text: (parts[i + 1] ?? "").trim() });
  return out;
}
