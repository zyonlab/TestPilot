import { Button, EmptyState } from "@/components/ui";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";

/**
 * 「这一屏已经不在这里了」。
 *
 * v3 把 TestPilot 切两半（`docs/v3/history/00-架构.md` §1）：产品层留在 `:5300`，
 * harness 层换成 PenguinHarness，跑在 `:7364`。工作流运行、画布、配对评测、
 * 变异、进程、能力、模型端点、提示词模板——这些问的都是「**这台机器怎么跑的**」，
 * 而它们现在由 Penguin 回答。
 *
 * 为什么留一屏而不是让地址 404：`?open=wfruns` / `?open=canvas` 这两个地址已经
 * 被人存过、发过（`open.ts` 的注释写着「拆掉导航不该顺手作废别人存下的链接」，
 * 这条规矩在这次搬家里同样成立）。一个死链只说"没有了"；这一屏说得出
 * **搬去哪了、点哪儿能到**。
 *
 * 为什么不 iframe 嵌 Penguin：`00-架构.md` §8 的红线之一。两个服务并行、
 * 靠深链互通，而不是把一个塞进另一个的框里。
 */

/**
 * Penguin 操作台的根地址。
 *
 * 走环境变量而不是写死：开发机上是 `127.0.0.1:7364`，别人的部署不是。
 * 默认值取的是 `00-架构.md` §2 写下的那个端口。
 */
export const PENGUIN_BASE: string = import.meta.env.VITE_PENGUIN_BASE ?? "http://127.0.0.1:7364";

/**
 * 深链的落点。
 *
 * **Penguin 的真实路由形状要等 Phase 0 跑通才知道**，所以先指 `/traces`
 * （session 的事件流是这几屏共同的去处），并且把它单独拎成一个常量：
 * 改一次路由只改这一行，而不是去十处 `${PENGUIN_BASE}/...` 里找。
 */
export const PENGUIN_TRACES = "/traces";

export const penguinUrl = (path: string = PENGUIN_TRACES): string => `${PENGUIN_BASE}${path}`;

/** 在新标签页打开 Penguin。不在本页跳走：人手上这一屏的筛选和光标还在。 */
export const openPenguin = (path: string = PENGUIN_TRACES): void => {
  window.open(penguinUrl(path), "_blank", "noopener,noreferrer");
};

/**
 * 一张搬迁空态。
 *
 * `EmptyState` 的注释要求空态说清三件事：这里为什么空、空不等于坏、下一步点哪儿。
 * 搬迁是「空不等于坏」最典型的一种，所以这三件事在这里分别是：
 * 搬走的是哪几样（标题）、为什么搬（正文）、去哪儿看（那颗按钮）。
 *
 * `bare` 给嵌在别的页面里用（迭代评测那一屏的下半截）：那时它不该再顶一条页头。
 */
export function MigratedToPenguin({ bare }: { bare?: boolean }) {
  const t = useT();
  const body = (
    <div className="flex-1 overflow-auto p-4">
      <EmptyState
        className="max-w-3xl"
        /* 卡片的标题是**搬走的那几样的名字**，不是再印一遍页头上那句话：
           同一句话在一屏里出现两遍，人会以为它们说的是两件事（`TopBar` 的③）。 */
        title={t("penguin.movedList")}
        body={t("penguin.movedWhy", { base: PENGUIN_BASE })}
        actions={
          <Button variant="primary" onClick={() => openPenguin()}>
            {t("penguin.open")}
          </Button>
        }
      />
    </div>
  );
  if (bare) return body;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title={t("penguin.movedTitle")} hint={t("penguin.movedHint")} />
      {body}
    </div>
  );
}
