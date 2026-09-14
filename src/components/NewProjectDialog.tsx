import { navigateProject } from '@/lib/projectContext';
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Dialog } from "@/components/overlay";
import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import type { TargetPlatform } from "@/lib/types";

/**
 * 建一个项目。
 *
 * 此前这张表单只长在设置抽屉的「项目」那一节里——也就是说，**建第一个项目要先想到去翻设置**。
 * 一个刚打开产品的人面对的是一张空画布，而他唯一该做的那件事藏在齿轮后面；
 * 设置装的应该是「跨一次工作存在、以周计才改一次」的东西，而建项目恰恰相反：
 * 它是这个产品的第一个动作，而且做完就不再回来。
 *
 * 所以表单搬到这里，成为一个可以从任何地方打开的对话框；设置那一节保留的是
 * **管理已有项目**（列表、平台、删除），那部分确实是设置。
 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** 建完之后做什么。工作台建完要落到新项目上，设置里建完只要刷新列表。 */
  onCreated?: (projectId: string) => void;
}) {
  const t = useT();
  const createProject = useStore((s) => s.createProject);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [platform, setPlatform] = useState<TargetPlatform>("web");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // 每次重新打开都是一张干净的表：上一次填了一半就关掉的内容留着，
  // 下一次会被当成「我已经填过了」，而它多半是另一个项目的半截信息。
  useEffect(() => {
    if (!open) return;
    setName("");
    setUrl("https://");
    setPlatform("web");
    setBusy(false);
    setFailed(false);
  }, [open]);

  const valid = !!name.trim() && /^https?:\/\/.+/.test(url.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setFailed(false);
    const project = await createProject(name.trim(), url.trim(), platform, []);
    setBusy(false);
    // 没建成就**不关**。关掉再什么都不说，等于告诉人「成了」——
    // 而他要到下次翻项目列表时才发现没有。
    if (!project) {
      setFailed(true);
      return;
    }
    navigateProject("canvas",{projectId:project.id});
    onClose();
    onCreated?.(project.id);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("projects.newProject")} widthClass="max-w-lg">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="np-name" className="mb-1 block text-xs text-muted-foreground">
            {t("projects.name")}
          </label>
          <input
            id="np-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My web app"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="np-url" className="mb-1 block text-xs text-muted-foreground">
            {t("projects.targetUrl")}
          </label>
          <input
            id="np-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="np-plat" className="mb-1 block text-xs text-muted-foreground">
            {t("projects.platform")}
          </label>
          <select
            id="np-plat"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as TargetPlatform)}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="web">Web</option>
            <option value="ios">iOS</option>
            <option value="android">Android</option>
          </select>
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            {platform === "web" ? t("projects.platformWebHint") : t("projects.platformNativeHint")}
          </p>
        </div>
      </div>

      {failed && (
        <p className="mt-3 flex items-start gap-1.5 text-[0.75rem] text-bad">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          {t("projects.createFailed")}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={!valid || busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("projects.createProject")}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </Dialog>
  );
}
