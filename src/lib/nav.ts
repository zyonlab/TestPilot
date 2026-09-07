import { SURFACES, type Surface } from "@/lib/surfaces";

/**
 * 左导航：这个产品有哪几处可以去。
 *
 * 为什么现在有导航了——而 `App.tsx` 的注释说过「没有路由表，只有工作台」：
 * 那一版的判断是「目录要求人先记住每样东西归在哪一类」，这句话至今成立，
 * 但它推出的结论（**所有东西都从画布上的产物卡进入**）被两件事推翻了：
 *
 * ① 九个工具族的调研里，十个 review-heavy 的产品没有一个把画布放在中心，
 *    而 Dagster / Temporal / Prefect 更是刻意不给可编辑画布；
 * ② 「每类产物一张卡」随类型数线性劣化——13 类就是 13 张卡，
 *    人仍然要先在脑子里建一张地图，只是那张地图从菜单换成了画布。
 *
 * 所以回到导航，但**不是回到原来那五扇门**：分组按「人在干什么」而不是按技术模块，
 * 而且**地址机制一个字都没改**——仍然是那一个地址加 `?open=`，
 * 旧链接照样能打开。换的是它渲染成浮层还是渲染成一屏。
 */
export interface NavItem {
  /** 与 `?open=` 里的值一致。画布是 `"canvas"`——空串曾经是它，现在表示「没写」（见 `App.tsx`）。 */
  id: string;
  /** i18n key。 */
  title: string;
  /** 一个字符做图标，避免为导航引一套图标库。 */
  glyph: string;
  /** 需要先选中项目才有内容可看。 */
  needsProject?: boolean;
}

export interface NavGroup {
  /** i18n key。 */
  title: string;
  items: NavItem[];
}

const s = (id: string): Surface | undefined => SURFACES.find((x) => x.id === id);
const from = (id: string, glyph: string, title?: string): NavItem => ({
  id,
  glyph,
  title: title ?? s(id)?.title ?? id,
  needsProject: s(id)?.needsProject,
});

/**
 * 四组，按「人在干什么」分。
 *
 * 顺序有意：**复核在第一个**，因为它是这个产品每天要做上百次的事，
 * 其余是每周几次的。把最常做的事放在第一位不是审美，是把预算花在正确的地方。
 */
/**
 * 四组，按「人在干什么」分，**每组一屏一项**。
 *
 * 顺序有意：**复核在第一个**，因为它是这个产品每天要做上百次的事，
 * 其余是每周几次的。把最常做的事放在第一位不是审美，是把预算花在正确的地方。
 *
 * 为什么从 18 项收回到 11 项——两条：
 *
 * ① 「运行」这一个概念此前裂成四个入口（画布 / 工作流运行 / 套件批次 / 执行记录），
 *    而 `nav.ts` 自己要写一段注释才说得清这四个的区别。**需要注释才分得清的导航，
 *    人扫一眼是分不出来的。** 现在画布降级成「运行」的详情——点进一次运行才看到它，
 *    这也正是原型里的走法（运行列表 → `运行 · wf-xxx`）；执行记录与趋势并到「执行」。
 *
 * ② 同一个对象的不同镜头不该各占一个导航项。看板 / 复核队列 / 需求追溯问的都是
 *    「这批用例怎么样」，它们现在是**页头上的 tab**（见 `SurfaceTabs`）：
 *    一次点击就能换镜头，而不是回到左边再找一遍。
 *
 * 每一屏都还在，地址也一个字没改——`?open=cases`、`?open=trends` 照样打得开。
 */
/**
 * **v3 改为三组七项，因为这个产品被切成两半了。**
 *
 * `docs/v3/00-架构.md` §1/§2：harness 层换成 PenguinHarness（`:7364`），
 * TestPilot 只留产品层。于是导航里回答「这台机器怎么跑的」那几项**不再属于这里**：
 * 工作流运行（`wfruns`）与它的详情画布搬去 Penguin 的 trace，
 * 配对评测与变异搬去 Penguin 的 benchmark，进程 / 能力与 chat / 模型端点 /
 * 提示词模板四个设置分节同理。地址仍然打得开（见 `surfaces.tsx` 的 `wfruns`），
 * 但它们不再占一行导航——**留在导航里的每一项，都必须是这台机器自己能回答的问题**。
 *
 * 上面那两条分组规矩原样沿用，只是它们现在推出了不同的结论：
 *
 * ① 「分组按人在干什么」——第一组不再叫「工作」而叫**审计**。
 *    因为人在这里干的事变了：一次运行生成 297 条、被人决定 0 条，
 *    说明「逐条评分」不是一件人会做的事（详见 `Review.tsx` 的审计台注释）。
 *    审计 = 决定什么进套件（review）· 看产出了什么（artifacts）· 交出去（deliver）。
 * ② 「两项的组不值一行标题」——所以 `batches` 不再单占一项：
 *    套件批次 / 执行记录 / 趋势并到 `artifacts` 的页头做 tab（同一个对象的三个镜头），
 *    否则第一组会剩下两项加一行标题。
 */
export const NAV: NavGroup[] = [
  {
    /** 审计：这个产品每天要做的事。**复核仍在第一位**，理由未变——预算花在最常做的动作上。 */
    title: "nav.audit",
    items: [from("review", "◧"), from("artifacts", "◇"), from("deliver", "⤓")],
  },
  {
    /**
     * 素材与质量：**每周看几次的那四样**，和上面每天做上百次的事分开。
     *
     * 原来这里是两组各两项。分组是为了减少扫描，而一个只有两项的组几乎不减少什么，
     * 却各占一行组标题——四行标题管十一个条目。合成一组之后
     * 「拿什么测（数据）/ 跑的是什么（代码）/ 测的是什么（产品地图）/ 这套 harness 好不好（评测）」
     * 待在一起，正好都是「要拿来对照、但不是每天点的东西」。
     *
     * v3 不动这一组的成员，但 `evals` 里只剩**覆盖矩阵**：它问的是「这套 harness
     * 拆得对不对」，属于这台机器；配对评测与变异问的是「这一版 harness 比上一版好不好」，
     * 属于 Penguin 的 benchmark。
     */
    title: "nav.material",
    items: [from("data", "▩"), from("code", "⌗"), from("map", "◉"), from("evals", "◑")],
  },
  {
    /**
     * 项目这一组存在的理由是一次回归：设置原本是画布内部的抽屉，
     * 画布不再常驻之后它就跟着消失了。它必须在任何一屏上都进得去。
     *
     * v3 从「配置」改叫「项目」，因为它现在只剩项目的事：
     * 项目 / 环境 / Web3 / 危险区 / 语言与主题。属于 harness 的那四节搬走了，
     * 而一个只装项目设置的组，叫「配置」会让人以为模型端点还在里面。
     */
    title: "nav.project",
    items: [from("onboard", "⊕", "surface.onboard"), from("settings", "⚙", "nav.settings")],
  },
];

/** 这个 `?open=` 值在导航里是哪一项。 */
export const navItemFor = (openId: string): NavItem | undefined =>
  NAV.flatMap((g) => g.items).find((i) => i.id === openId);

/**
 * 左导航该高亮哪一项。
 *
 * 不是所有界面都在导航里——用例看板、执行记录、趋势现在是页头上的 tab。
 * 站在它们上面时，高亮的是**它们所属那一组的落点**：人是从「复核」点进看板的，
 * 导航就该一直说他在复核那一组里。没有这一步，切到 tab 之后左边会整个失去高亮，
 * 界面看起来像掉出了产品之外。
 */
export const navIdFor = (openId: string): string => {
  // 画布是「运行」的详情，不是一个独立落点——站在它上面时导航该继续高亮「运行」。
  // v3：这两个落点都搬去 Penguin 了，落到搬迁空态上。它们**不再高亮任何一项**——
  // 高亮一个已经不存在的父项，等于告诉人「你还在产品里的某一处」，而他不在。
  if (openId === "canvas") return "wfruns";
  if (navItemFor(openId)) return openId;
  const group = SURFACES.find((x) => x.id === openId)?.group;
  const inGroup = NAV.flatMap((g) => g.items).find(
    (i) => SURFACES.find((x) => x.id === i.id)?.group === group,
  );
  return inGroup?.id ?? openId;
};
