import { Button, EmptyState } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { openCard } from "@/lib/open";

/**
 * 「还没选项目」的**唯一**一处空态。
 *
 * 此前它散在四处、三套措辞（`model.selectProjectFirst` 两处、
 * Trends 与 Suite 各自把 `common.noProjectSelected` 当标题用），
 * 而且**没有一处带动作**——它只说「你缺一个项目」，不说去哪儿补。
 * 一句说不出下一步的空态，等于让人自己去找那扇门。
 *
 * `common.noProjectSelected` 保留，但只作**标签**用（导航底部、顶栏、下拉的占位项）——
 * 那些地方它是在陈述当前状态，不是在挡路。
 */
/*
 * 它现在长在 `EmptyState` 上，而不是自己再摆一遍那个盒子。
 *
 * 之前八处「还没选项目」是一行灰字（`<div className="p-4 text-sm …">`），
 * 只有四处用了这个组件——同一件事两种形状，而且那八处一个动作都不给。
 */
export function NeedProject({ what }: { what?: string }) {
  const t = useT();
  return (
    <EmptyState
      title={t("needProject.title")}
      body={what ? t("needProject.forWhat", { what }) : t("needProject.why")}
      actions={
        <Button variant="primary" onClick={() => openCard("onboard")}>
          {t("needProject.go")}
        </Button>
      }
    />
  );
}
