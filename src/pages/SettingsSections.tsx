import { useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { NeedProject } from "@/components/NeedProject";
import { Button } from "@/components/ui";
import { AppControls } from "@/components/AppControls";
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
 *
 * **v3：属于 harness 的那一节（提示词模板）从这里删掉了。** 上面这条依据正是理由——
 * 提示词现在随 skill 走进 `plugins/testpilot/`，改它影响的是 PenguinHarness 上的每一次运行，
 * 而不是这台机器（`docs/v3/history/00-架构.md` §2）。留下的两节都属于「这个项目」和「这个人」。
 *
 * 内容**左对齐**，不居中（此前是 `mx-auto max-w-2xl`）。守住 `max-w-2xl` 的行宽是对的，
 * 但居中之后它和上面那行 `why` 说明不共左边——`SectionPage` 的说明贴着左侧栏边缘，
 * 卡片却飘到屏幕中间，解释和被解释的东西各站一边。而全应用其余十屏都是左对齐满宽，
 * 只有设置这一片看起来像另一个产品的页面。
 */

export function EnvSection() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  if (!activeProjectId)
    return <div className="p-4"><NeedProject /></div>;
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-2xl space-y-4">
        <p className="text-sm text-muted-foreground">{t("model.envsSecretsHelp")}</p>
        <EnvironmentsCard />
        <SecretsCard />
      </div>
    </div>
  );
}

/**
 * 语言与主题。
 *
 * 这一节此前**没有切换语言的入口**：`AppControls` 写好了却没有被任何地方 import，
 * 于是 `i18n.ts` 里三语的词条只由 `navigator.language` 决定一次，整套 `.dark` 令牌
 * 也跟着不可达。而同一屏的调试开关还写着「切换界面语言即可切换目标语言」——
 * 界面在教人做一件它不提供的事。
 *
 * 它单独放在 `DebugPromptsCards` 前面，不进那张卡：语言和主题是纯本地偏好，
 * 而那张卡要先拿到服务端设置才渲染。后端没起的时候，人更需要能把语言切回来。
 */
export function PrefsSection() {
  const t = useT();
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-2xl space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-[0.8125rem] font-medium">{t("settings.appearance")}</h3>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">{t("settings.appearanceHelp")}</p>
          {/* `AppControls` 的语言组是 `flex-1`，为 180px 的导航栏量的。
              这张卡有 max-w-2xl 那么宽，不收一下会把三个语言按钮拉成三条 160px 的带子。 */}
          <div className="max-w-[15rem]">
            <AppControls />
          </div>
        </div>
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

  if (!project) return <div className="p-4"><NeedProject /></div>;

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
      <div className="max-w-2xl">
        <div className="rounded-xl border border-bad bg-card p-4">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-bad">
            <AlertTriangle className="h-4 w-4" />
            {t("danger.deleteTitle")}
          </h3>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("danger.deleteHelp")}</p>

          <div className="mt-2 flex flex-wrap gap-2 text-[0.75rem] text-muted-foreground">
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
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          {error && <p className="mt-2 text-[0.75rem] text-bad">{error}</p>}

          <Button
            variant="outline"
            disabled={!armed || busy}
            onClick={() => void remove()}
            className="mt-3 border-bad text-bad disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {t("danger.deleteButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}
