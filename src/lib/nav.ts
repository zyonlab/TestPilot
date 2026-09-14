import { SURFACES, type Surface } from "@/lib/surfaces";

/** Flow is the homepage; all review surfaces retain project/run/revision context. */
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

export const NAV: NavGroup[] = [
  { title: "bench.workflow", items: [{id:"canvas",title:"bench.title",glyph:"⌘"}] },
  { title: "nav.audit", items: [from("review", "◧"), from("artifacts", "◇"), from("runs", "▶"), from("baselines", "≡")] },
  { title: "nav.evals", items: [from("scoreboard", "◑"), from("gold", "★")] },
  { title: "nav.project", items: [from("settings", "⚙", "nav.settings")] },
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
  if (openId === "canvas" || openId === "wfruns") return "canvas";
  if (navItemFor(openId)) return openId;
  const group = SURFACES.find((x) => x.id === openId)?.group;
  const inGroup = NAV.flatMap((g) => g.items).find(
    (i) => SURFACES.find((x) => x.id === i.id)?.group === group,
  );
  if (inGroup) return inGroup.id;
  // T-26 之后没有导航项的组：素材类（data / code / map / deliver / evals 的覆盖矩阵）
  // 都是「复核」这件事的旁证，落到复核；引导与设置同属项目，落到设置。
  return group === "config" ? "settings" : group && group !== "penguin" ? "review" : openId;
};
