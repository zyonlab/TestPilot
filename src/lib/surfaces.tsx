import { CasesBoard } from "@/pages/CasesBoard";
import { ReviewPage } from "@/pages/Review";
import { TracePage } from "@/pages/Trace";
import { CodeLinePage, ChangesPage } from "@/pages/CodeLine";
import { Delivery } from "@/pages/Delivery";
import { RunReportPage } from "@/pages/RunReport";
import { SuitePage } from "@/pages/Suite";
import { BaselinesPage } from "@/pages/Baselines";
import { TrendsPage } from "@/pages/Trends";
import { EvalsPage } from "@/pages/Evals";

/**
 * 物料卡：每一件产物、队列、报告，都是从**产出它的那一步**打开的。
 *
 * 之前这些是导航里的落点：五扇门后面十九个分节。那解决了「东西放哪」，没解决「东西太多」——
 * 甚至更糟，因为一本目录要求人先记住每样东西归在哪一类，才找得到它。
 *
 * 现在的规则只有一条：**你通过正在处理的那个对象进入它**。画布上的 `design` 节点产出了一百条
 * 用例，那么用例看板、复核队列、需求追溯就挂在那张产物卡上；`repair` 产出了代码，代码线与变更
 * 就挂在它那张卡上。没有菜单，也没有启动器——需要先在脑子里建一张地图才能用的界面，
 * 正是这次要去掉的东西。
 *
 * 每个界面本身没有重写：它们是成熟的页面，只是不再各自占一个地址。
 */
/** 打开这张卡时，画布上正在看的是哪一次运行。 */
export interface SurfaceContext {
  wfRunId?: string;
}

export interface Surface {
  id: string;
  /** 同一组的界面在同一张卡里以 tab 并列——它们是同一个对象的不同镜头。 */
  group: string;
  title: string;
  render: (ctx: SurfaceContext) => React.ReactNode;
  /** 需要先选中项目才有内容可看。 */
  needsProject?: boolean;
}

export const SURFACES: Surface[] = [
  // 用例这一组：同一批用例的三种看法——它是什么、要不要它、它凭什么这么写。
  { id: "cases", group: "cases", title: "用例看板", render: () => <CasesBoard />, needsProject: true },
  // 唯一一个吃上下文的：从某次运行的门禁卡点进来，就该停在那一批上。
  { id: "review", group: "cases", title: "复核队列", render: (ctx) => <ReviewPage focusRun={ctx.wfRunId} /> },
  { id: "trace", group: "cases", title: "需求追溯", render: () => <TracePage />, needsProject: true },

  // 代码这一组：生成的、能跑的、被改过的，以及怎么进客户的仓库。
  { id: "code", group: "code", title: "测试代码", render: () => <CodeLinePage />, needsProject: true },
  { id: "changes", group: "code", title: "变更", render: () => <ChangesPage />, needsProject: true },
  { id: "deliver", group: "code", title: "交付与接入", render: () => <Delivery />, needsProject: true },

  // 运行这一组：被测产品的结果，加上唯一需要人点头的那一格。
  { id: "runs", group: "runs", title: "执行记录", render: () => <RunReportPage />, needsProject: true },
  { id: "batches", group: "runs", title: "套件批次", render: () => <SuitePage />, needsProject: true },
  { id: "baselines", group: "runs", title: "待审批基线", render: () => <BaselinesPage />, needsProject: true },
  { id: "trends", group: "runs", title: "趋势", render: () => <TrendsPage />, needsProject: true },

  // 这一版 harness 自己好不好——量的不是产品，所以它挂在图上，不挂在任何一个节点上。
  { id: "evals", group: "evals", title: "迭代评测", render: () => <EvalsPage /> },
];

export const surfaceById = (id: string): Surface | undefined => SURFACES.find((s) => s.id === id);
export const surfacesInGroup = (group: string): Surface[] => SURFACES.filter((s) => s.group === group);
