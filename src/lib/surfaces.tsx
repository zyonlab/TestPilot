import { CasesBoard } from "@/pages/CasesBoard";
import { MigratedToPenguin } from "@/components/MigratedToPenguin";
import { ReviewPage } from "@/pages/Review";
import { ProductMap } from "@/pages/ProductMap";
import { DatasetsPage } from "@/pages/Datasets";
import { TracePage } from "@/pages/Trace";
import { CodeLinePage, ChangesPage } from "@/pages/CodeLine";
import { Delivery } from "@/pages/Delivery";
import { RunReportPage } from "@/pages/RunReport";
import { SuitePage } from "@/pages/Suite";
import { BaselinesPage } from "@/pages/Baselines";
import { TrendsPage } from "@/pages/Trends";
import { EvalsPage } from "@/pages/Evals";
import { ArtifactsPage } from "@/pages/Artifacts";
import { OnboardPage } from "@/pages/Onboard";
import { SettingsBody } from "@/components/SettingsDrawer";

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
  /**
   * 打开这张卡时要落在哪一处（`edge:/a->/b`、`state:/a`）。
   *
   * 从缺口清单点进地图时带过来。放在 URL 里而不是全局状态里，
   * 是因为**这个落点必须能被贴给别人**——「你看这条路没人验」这句话
   * 不该只能靠口头描述。
   */
  focus?: string;
}

export interface Surface {
  id: string;
  /** 同一组的界面在同一张卡里以 tab 并列——它们是同一个对象的不同镜头。 */
  group: string;
  /**
   * i18n 的 key，不是文字。
   *
   * 这里原来直接写中文，于是这十二个 tab 标题**永远只有中文**，
   * 而界面其余部分跟随语言设置——英文用户看到的是半中半英。
   * 存 key、在渲染处翻译：语言是视图的事，不是这张表的事。
   */
  title: string;
  render: (ctx: SurfaceContext) => React.ReactNode;
  /** 需要先选中项目才有内容可看。 */
  needsProject?: boolean;
}

export const SURFACES: Surface[] = [
  /**
   * 探索这一组：它走出来的那张地图。
   *
   * 挂在 explore 卡上而不是塞进复核抽屉，是照这个界面自己的规矩办的——
   * 「你通过正在处理的那个对象进入它」。地图是 explore 产出的，就从 explore 进。
   * 但缺口在复核那一侧，所以复核里的缺口能点过来（见 Review 的 `mapHref`），
   * 两边靠 URL 里的落点串起来，而不是把地图复制一份塞进复核。
   */
  {
    id: "map",
    group: "explore",
    title: "surface.map",
    render: (ctx) => <ProductMap focusRun={ctx.wfRunId} focus={ctx.focus} />,
  },

  // 用例这一组：同一批用例的三种看法——它是什么、要不要它、它凭什么这么写。
  // 唯一一个吃上下文的：从某次运行的门禁卡点进来，就该停在那一批上。
  {
    id: "review",
    group: "review",
    title: "surface.review",
    render: (ctx) => <ReviewPage focusRun={ctx.wfRunId} />,
  },
  { id: "cases", group: "review", title: "surface.cases", render: () => <CasesBoard />, needsProject: true },
  { id: "trace", group: "review", title: "surface.trace", render: () => <TracePage />, needsProject: true },
  /**
   * 数据和用例同一组：一条数据驱动的用例，「测什么」和「拿什么测」是同一件事的两半，
   * 分到两个地方看，人就得自己在脑子里把它们拼起来。
   */
  { id: "data", group: "data", title: "surface.data", render: () => <DatasetsPage />, needsProject: true },

  // 代码这一组：生成的、能跑的、被改过的，以及怎么进客户的仓库。
  { id: "code", group: "code", title: "surface.code", render: () => <CodeLinePage />, needsProject: true },
  {
    id: "changes",
    group: "code",
    title: "surface.changes",
    render: () => <ChangesPage />,
    needsProject: true,
  },
  {
    id: "deliver",
    group: "deliver",
    title: "surface.deliver",
    render: () => <Delivery />,
    needsProject: true,
  },

  /**
   * 物料：一份统一列表，取代「每类产物一张卡」。
   *
   * 那个形态随类型数线性劣化——13 类就是 13 张卡，人仍然要先建一张地图才找得到东西。
   * 加一类产物现在只是列表里多一行。
   *
   * **v3 把它挪进 `exec` 组，因为「套件批次 · 执行记录 · 趋势」要挂到它的页头上。**
   * 那三样此前由 `batches` 一项领着占一行导航；而它们和物料问的是同一个对象的四个镜头
   * ——这一批产出了什么（物料）/ 怎么跑的（批次）/ 跑出了什么（执行记录）/ 一直以来怎么样（趋势）。
   * 排在这一组的第一位：它是导航里那一项，tab 的第一格该就是人点进来的那一格。
   */
  { id: "artifacts", group: "exec", title: "surface.artifacts", render: () => <ArtifactsPage /> },

  /**
   * 工作流运行的管理屏。它和 `runs` 不是一回事：那一屏是**用例执行**的记录，
   * 这一屏是**工作流运行**——两者此前共用一个词，而它们连主语都不同。
   *
   * **v3 改为搬迁空态，因为工作流运行不再由这台机器管**（`00-架构.md` §1/§2）：
   * session / events / traces 全部归 PenguinHarness。这里保留这条登记项**只为了地址**
   * ——`?open=wfruns` 已经被人存过发过，一个死链只说"没有了"，而这一屏说得出搬去哪。
   * 它因此不在 `NAV` 里（见 `nav.ts`），只有旧链接会落到它。
   * Phase 3：页面文件 `pages/WfRuns.tsx` 已删——入口早就断了，代码留着没人读得到。
   */
  { id: "wfruns", group: "penguin", title: "penguin.movedTitle", render: () => <MigratedToPenguin /> },
  { id: "batches", group: "exec", title: "surface.batches", render: () => <SuitePage />, needsProject: true },
  // 「执行记录」问的是被测产品跑出了什么，「套件批次」问的是这一批怎么跑的——
  // 同一件事的结果与过程，所以并列成 tab，而不是各占一个导航项。
  { id: "runs", group: "exec", title: "surface.runs", render: () => <RunReportPage />, needsProject: true },
  {
    id: "baselines",
    group: "data",
    title: "surface.baselines",
    render: () => <BaselinesPage />,
    needsProject: true,
  },
  { id: "trends", group: "exec", title: "surface.trends", render: () => <TrendsPage />, needsProject: true },

  // 这一版 harness 自己好不好——量的不是产品，所以它挂在图上，不挂在任何一个节点上。
  { id: "evals", group: "evals", title: "surface.evals", render: () => <EvalsPage /> },

  /**
   * 设置。
   *
   * 它原来只是画布内部的一个抽屉，入口是工具条右端的齿轮——左导航落地之后画布不再常驻，
   * 那个齿轮就跟着消失了，站在复核屏上**建不了项目、改不了模型端点**。
   * 登记成一个界面，它才在任何一屏上都进得去。抽屉那条路保留：从画布点齿轮仍然是抽屉，
   * 因为那时人正在看一次运行，不该被整屏切走。
   */
  /**
   * 接入：从零到第一批可复核用例，还差哪几条。
   *
   * 排在设置前面——它回答的是「现在能不能开始干活」，而设置回答的是「以后怎么跑」。
   * 前者每个新环境都要问一次，后者以周计。
   */
  { id: "onboard", group: "config", title: "surface.onboard", render: () => <OnboardPage /> },
  { id: "settings", group: "config", title: "nav.settings", render: () => <SettingsBody /> },
];

export const surfaceById = (id: string): Surface | undefined => SURFACES.find((s) => s.id === id);
export const surfacesInGroup = (group: string): Surface[] => SURFACES.filter((s) => s.group === group);
