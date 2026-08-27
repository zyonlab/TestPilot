import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { api } from "@/lib/api";
import { DebugPromptsCards, EnvironmentsCard, SecretsCard } from "@/pages/ModelConfig";

/**
 * 设置里那几节，此前都埋在「模型配置」那一页里。
 *
 * 它们只是碰巧被同一个文件装着，彼此并没有关系：**环境**属于项目（同一批用例跑在不同环境上）、
 * **提示词模板**属于 harness（改它会进指纹，影响每一次后续运行）、**语言与调试**属于这个人。
 * 而模型端点属于运行时。四件事挂在一个标题下，找起来只能靠记得它在哪。
 */

export function EnvSection() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  if (!activeProjectId) return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-sm text-muted-foreground">{t("model.envsSecretsHelp")}</p>
        <EnvironmentsCard />
        <SecretsCard />
      </div>
    </div>
  );
}

export function PromptsSection() {
  const t = useT();
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings.promptsHelp")}</p>
        <DebugPromptsCards show="prompts" />
      </div>
    </div>
  );
}

export function PrefsSection() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <DebugPromptsCards show="prefs" />
      </div>
    </div>
  );
}

/**
 * 危险操作：不可逆，且级联。
 *
 * 二次确认用的是应用内的对话框，不是 `window.confirm`。原生模态会阻塞页面事件循环——
 * harness 跑到这一步就再也驱动不了浏览器了。一个要能测自己的产品，不能在关键路径上
 * 用浏览器原生弹窗。
 *
 * 确认方式是**照抄项目名**，不是点一下「确定」：级联删除会带走这个项目下的用例、运行、
 * 基线、环境与密钥，代价配得上多打几个字。
 */
export function DangerSection() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const exitProject = useStore((s) => s.exitProject);
  const loadData = useStore((s) => s.loadData);
  const cases = useStore((s) => s.cases);
  const project = projects.find((p) => p.id === activeId);

  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!project) return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;

  const armed = typed.trim() === project.name;

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteProject(project.id);
      exitProject();
      await loadData();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-xl border border-rose-500/40 bg-card p-4">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-4 w-4" />
            {t("danger.deleteTitle")}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("danger.deleteHelp")}</p>

          <div className="mt-2 flex flex-wrap gap-2 text-[12px] text-muted-foreground">
            <span className="rounded bg-muted px-2 py-0.5 font-mono">
              {cases.length} {t("deliver.cases")}
            </span>
            <span className="rounded bg-muted px-2 py-0.5 font-mono">{project.targetUrl}</span>
          </div>

          <label htmlFor="confirmname" className="mt-3 block text-xs text-muted-foreground">
            {t("danger.typeName").replace("{name}", project.name)}
          </label>
          <input
            id="confirmname"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={project.name}
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />

          {error && <p className="mt-2 text-[12px] text-rose-500">{error}</p>}

          <Button
            variant="outline"
            disabled={!armed || busy}
            onClick={() => void remove()}
            className="mt-3 border-rose-500/50 text-rose-600 disabled:opacity-40 dark:text-rose-400"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t("danger.deleteButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}
