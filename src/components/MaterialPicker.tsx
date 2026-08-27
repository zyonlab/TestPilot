import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 勾选这次运行读哪几份材料。
 *
 * `paths` 此前只能在参数的 JSON 文本框里手写一个字符串数组。那不是一件小麻烦：
 * **规格是下游一切的输入**，而选错一份文档不会报错——文件读不到才报错；路径拼对了、
 * 选的却是另一份，只会在二十分钟后变成一批看起来正常、其实答非所问的用例。
 *
 * 勾选框在旁边，JSON 文本框留着：参数还有 `path` 和 `text` 两种形式，而且一个只能靠
 * 勾选的界面，遇到不在列表里的路径就把人挡死了。两者写的是同一个字段，勾选只是它的
 * 一个视图。
 */
interface MaterialFile {
  path: string;
  bytes: number;
}

export function MaterialPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (paths: string[]) => void;
}) {
  const t = useT();
  const [files, setFiles] = useState<MaterialFile[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/api/materials`)
      .then((r) => r.json())
      .then((d: { files?: MaterialFile[]; error?: string }) => {
        if (d.error) return setError(d.error);
        setFiles(d.files ?? []);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const toggle = (path: string) =>
    onChange(selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path]);

  // 选中但列表里没有的路径照样显示出来：删掉它才是真正的数据丢失。
  const missing = selected.filter((p) => !files.some((f) => f.path === p));

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <FileText className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11.5px] font-medium">{t("wf.materials")}</span>
        <span className="text-[11px] text-muted-foreground">
          {t("wf.materialsChosen").replace("{n}", String(selected.length))}
        </span>
      </div>
      {error && <div className="px-2 py-1.5 text-[11.5px] text-rose-500">{error}</div>}
      <div className="max-h-48 overflow-auto">
        {missing.map((p) => (
          <label key={p} className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-muted">
            <input type="checkbox" checked onChange={() => toggle(p)} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-amber-600 dark:text-amber-400">
              {p}
            </span>
            <span className="shrink-0 text-[10.5px] text-amber-600 dark:text-amber-400">
              {t("wf.materialsMissing")}
            </span>
          </label>
        ))}
        {files.map((f) => (
          <label
            key={f.path}
            className={cn(
              "flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-muted",
              selected.includes(f.path) && "bg-primary/5",
            )}
          >
            <input
              type="checkbox"
              checked={selected.includes(f.path)}
              onChange={() => toggle(f.path)}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{f.path}</span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
              {(f.bytes / 1024).toFixed(1)}k
            </span>
          </label>
        ))}
      </div>
      {/* 顺序是人定的：多份文档拼起来时，先读到的那份会主导拆出来的故事。 */}
      <p className="border-t border-border px-2 py-1 text-[10.5px] leading-relaxed text-muted-foreground">
        {t("wf.materialsOrder")}
      </p>
    </div>
  );
}
