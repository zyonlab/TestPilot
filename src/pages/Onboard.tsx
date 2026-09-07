import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { API_BASE } from "@/lib/base";
import { openCard } from "@/lib/open";
import { openPenguin } from "@/components/MigratedToPenguin";
import { cn } from "@/lib/cn";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { SutPanel } from "@/components/SutPanel";

/**
 * 接入：**从零到第一批可复核用例，还差哪几条。**
 *
 * 一条定长清单（v3 之后是五项，模型那条随 harness 搬去了 Penguin），而不是一张健康度
 * 仪表盘：人要的是「还差几条」和「先修哪一条」，
 * 而一个 73% 的就绪度谁也不知道该从哪儿下手。状态只有四种，也是同一个道理。
 *
 * 这一屏解决的是一次真实的冷启动矛盾：库里可能一个项目都没有，而磁盘上躺着几十次
 * 历史运行——此前第一屏同时说着「这里什么都没有」和「这是最近一次运行的一百条用例」，
 * 两句话都很确定，互相矛盾。所以这里把两件事一起说出来，
 * 而且**空态是队列自己的空态，不是盖在别的东西上的一张卡**。
 *
 * 判定全部由服务端算（`/api/readiness`）：守卫的白名单、环境的登录态、能力的健康检查、
 * 预算的默认值，四样都只有网关知道。前端另算一套，最后一定会给出两个不同的答案。
 */
/** 一句可本地化的话：要么本来就没有需要翻译的字（项目名 · 地址），要么是一个词条。 */
type Msg = string | { key: string; params?: Record<string, string | number> };

interface Item {
  id: string;
  state: "none" | "unverified" | "ok" | "broken";
  /** 服务端给的是**词条 key 加参数**，不是拼好的句子——纯数据的那几条仍是字符串。 */
  detail: Msg;
  hint?: Msg;
}

/** 每一条通向哪儿——「还差什么」必须带着「去哪儿补」，否则它只是一句抱怨。 */
/**
 * **v3：`model` 那一条不在这张清单里了，其余五条的落点也重新指过。**
 *
 * 清单问的是「现在能不能开始干活」，而 v3 之后「模型端点配好没有」这个问题的答主
 * 换成了 PenguinHarness（`docs/v3/00-架构.md` §2：模型归 session、能力与进程归
 * penguin-core）。留在这里的五条——项目 / 环境（运行时）/ 被测对象 / 守卫 / 预算
 * ——都是这台机器自己答得上的。
 *
 * 落点跟着变：原来指向设置里 `model` / `capabilities` 两个分节的那几条，
 * 分节已经删了（见 `SettingsDrawer`），继续指过去会落到一个不存在的分节上，
 * 而 `SectionPage` 的 fallback 会把人静默丢回「项目」——一颗写着「去配置守卫」
 * 却打开项目列表的按钮，比没有这颗按钮更糟。
 */
const GOES: Record<string, { surface: string; section?: string; penguin?: boolean }> = {
  project: { surface: "settings", section: "projects" },
  sut: { surface: "settings", section: "env" },
  // 运行时（能力进程）与守卫白名单现在都由 Penguin 那边管，按钮直接把人送过去。
  runtime: { surface: "settings", penguin: true },
  guard: { surface: "settings", penguin: true },
  budget: { surface: "settings", section: "env" },
};

/**
 * 清单里这台机器还答得上的那几条。
 *
 * 服务端 `/api/readiness` 仍然会算 `model`（它读的是本地设置，Phase 1C 之前不会变），
 * 所以在前端滤掉，而不是等后端改。滤掉而不是显示成灰色：一条永远不会变绿、
 * 又指不出该去哪儿补的清单项，会让「还差几条」这个数字永远差一条。
 */
const MOVED_TO_PENGUIN = new Set(["model"]);

export function OnboardPage() {
  const t = useT();
  /* 服务端给 key 就翻，给字符串就直接用（那几条里没有一个字需要翻译）。 */
  const msg = (m?: Msg): string => (m == null ? "" : typeof m === "string" ? m : t(m.key, m.params));
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [data, setData] = useState<{
    items: Item[];
    okCount: number;
    total: number;
    projects: number;
    historicalRuns: number;
  } | null>(null);
  const [picked, setPicked] = useState("project");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const q = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : "";
      const r = await fetch(`${API_BASE}/api/readiness${q}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as {
        items: Item[];
        okCount: number;
        total: number;
        projects: number;
        historicalRuns: number;
      };
      /* 分子分母要跟着一起收：滤掉一条却留着原来的 total，
         清单会永远停在「5 / 6」，而人找不到第六条在哪。 */
      const items = body.items.filter((i) => !MOVED_TO_PENGUIN.has(i.id));
      setData({
        ...body,
        items,
        okCount: items.filter((i) => i.state === "ok").length,
        total: items.length,
      });
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [activeProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cur = data?.items.find((i) => i.id === picked) ?? data?.items[0];
  const selectProject = useStore((s) => s.selectProject);
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title={t("surface.onboard")}
        sub={data ? t("onboard.okOf", { k: data.okCount, n: data.total }) : undefined}
        actions={
          <>
            {/*
              「新建项目」是这一屏的主动作，就摆在页头上——原型 v3 里也是这么放的。
              此前它不在这儿，于是清单第一条「还没有项目」只能把人推去
              「去配置 → 设置 → 项目 → 新建项目」，五步跨三屏，
              而这一屏的全部意义就是回答「现在还差哪一条」。
            */}
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t("projects.newProject")}
            </Button>
            <Button onClick={() => void load()}>{t("onboard.recheck")}</Button>
          </>
        }
      />
      <NewProjectDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => {
          setAdding(false);
          void selectProject(id).then(() => void load());
        }}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[22.5rem] flex-none flex-col overflow-y-auto border-r border-border">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
            {t("onboard.checklist")}
            <span className="ml-auto tabular-nums">
              {data ? t("onboard.okOf", { k: data.okCount, n: data.total }) : "…"}
            </span>
          </div>
          {err && <p className="p-3 text-[0.8125rem] text-bad">{err}</p>}
          {(data?.items ?? []).map((it) => (
            <button
              key={it.id}
              type="button"
              aria-current={picked === it.id ? "true" : "false"}
              onClick={() => setPicked(it.id)}
              className={cn(
                "flex items-start gap-3 border-b border-border px-3 py-2.5 text-left",
                picked === it.id
                  ? "bg-accent shadow-[inset_3px_0_0_hsl(var(--primary))]"
                  : "hover:bg-accent/50",
              )}
            >
              <Dot state={it.state} />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.875rem] font-medium">{t(`onboard.item.${it.id}`)}</span>
                <span className="mt-0.5 block truncate text-[0.75rem] text-muted-foreground">{msg(it.detail)}</span>
              </span>
              <Pill state={it.state} />
            </button>
          ))}
          {/*
            冷启动的两句话要**同屏**说完。
            此前它们分属两处：空态卡说「这里什么都没有」，画布上铺着最近一次运行的产物。
          */}
          {data && (
            <p className="p-3 text-[0.75rem] leading-relaxed text-muted-foreground">
              {t("onboard.machine", { p: data.projects, r: data.historicalRuns })}
            </p>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {/*
            全绿之后**这一屏此前什么都不做**：右侧只剩一颗 `去配置`，
            而人刚刚就是配完才走到这里的。一份把人送到终点却不说终点在哪的清单，
            人只能自己猜下一步该点导航里的哪一项。
          */}
          {data && data.okCount === data.total && (
            <div className="mb-5 rounded-xl border border-ok bg-ok-soft p-4">
              <h2 className="text-[1.0625rem] font-semibold text-ok">{t("onboard.allSet")}</h2>
              <p className="mt-1 max-w-2xl text-[0.8125rem] leading-relaxed text-ink2">
                {t("onboard.allSetWhy")}
              </p>
              {/* 「跑第一次」不再落在这台机器的工作流运行屏上——那一屏搬去 Penguin 了。 */}
              <Button variant="success" className="mt-3" onClick={() => openPenguin()}>
                {t("onboard.startFirstRun")}
              </Button>
            </div>
          )}
          {cur && (
            <>
              <h2 className="text-[1.0625rem] font-semibold">{t(`onboard.item.${cur.id}`)}</h2>
              <p className="mt-1 text-[0.8125rem] text-muted-foreground">{msg(cur.detail)}</p>
              {cur.hint && (
                <div className="mt-3 max-w-2xl rounded-lg border border-warn bg-warn-soft px-3 py-2 text-[0.8125rem] leading-relaxed text-warn">
                  {msg(cur.hint)}
                </div>
              )}
              <p className="mt-4 max-w-2xl text-[0.8125rem] leading-relaxed text-muted-foreground">
                {t(`onboard.why.${cur.id}`)}
              </p>
              {/*
                被测对象这一条**就地可改**，不必跳去设置：它是六条里唯一一个
                「填完立刻能验证」的，而验证结果（逐步日志）本身就是这一条的证据。
                其余几条仍然跳设置——那些是每周改一次的东西，不值得在这里再造一遍表单。
              */}
              {cur.id === "sut" && activeProjectId && (
                <div className="mt-5 border-t border-border pt-4">
                  <SutPanel projectId={activeProjectId} onChanged={() => void load()} />
                </div>
              )}
              <div className="mt-4">
                <Button
                  variant="primary"
                  onClick={() => {
                    const g = GOES[cur.id];
                    if (g?.penguin) openPenguin();
                    else if (g?.section) {
                      // 设置内部用 `?s=` 记分节，和它自己那套导航保持一致。
                      const [path] = window.location.hash.split("?");
                      window.location.hash = `${path || "#/"}?open=settings&s=${g.section}`;
                    } else openCard(g?.surface ?? "settings");
                  }}
                >
                  {t("onboard.goFix")}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 绿色只留给**已验证**。`unverified` 是琥珀色——「配了」和「验过了」是两件事。 */
function Dot({ state }: { state: Item["state"] }) {
  return (
    <span
      className={cn(
        "mt-1 h-2 w-2 flex-none rounded-full",
        state === "ok"
          ? "bg-ok"
          : state === "broken"
            ? "bg-bad"
            : state === "unverified"
              ? "bg-warn"
              : "bg-muted-foreground/30",
      )}
    />
  );
}

function Pill({ state }: { state: Item["state"] }) {
  const t = useT();
  return (
    <span
      className={cn(
        "flex-none rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
        state === "ok"
          ? "bg-ok-soft text-ok"
          : state === "broken"
            ? "bg-bad-soft text-bad"
            : state === "unverified"
              ? "bg-warn-soft text-warn"
              : "bg-muted text-muted-foreground",
      )}
    >
      {t(`onboard.state.${state}`)}
    </span>
  );
}
