import type { Mutant } from "./operators.js";

/**
 * 把一个变异体注进跑着的产品。
 *
 * **注在浏览器里，不注在被测应用里。**这一点是黑盒变异测试成立的关键：
 * 被测应用一个字节都不改，容器不重建，两次运行之间它仍然是同一个东西。
 * 变的只是这一个浏览器会话看到的那一份 DOM。
 *
 * 用 `MutationObserver` 持续应用而不是加载后改一次：单页应用会不断重绘，
 * 改一次的效果几秒钟就被覆盖掉——那会让变异体"活下来"，而它其实根本没生效过。
 * **一个没生效的变异体会被记成"用例没抓到"，那是最坏的一种错**：
 * 它把工具自己的失败伪装成用例集的盲区。
 *
 * 所以注入脚本自己记账：改了多少处，写在 `window.__tpMutation`，注入方读得到。
 * 改了 0 处的变异体不算"活下来"，算**没生效**，报告里必须分开。
 */
export function buildMutationScript(m: Mutant): string {
  const cfg = JSON.stringify({
    op: m.operator,
    target: m.target,
    replacement: m.replacement ?? "",
    id: m.id,
  });
  // 这段代码在浏览器里跑。不能有具名内部函数——打包器的 keepNames 会注入
  // `__name`，而那个东西只存在于打包产物里（探索那边踩过一次，表现为"0 个控件"）。
  return `
(() => {
  const cfg = ${cfg};
  const state = { id: cfg.id, op: cfg.op, applied: 0 };
  window.__tpMutation = state;

  const apply = () => {
    if (cfg.op === "text") {
      // 大小写不敏感。变异目标取自图的控件文案，那些是 innerText 采的，
      // 而 innerText 会应用 CSS 的 text-transform，DOM 文本节点不会。
      // PetClinic 的导航看起来是 FIND OWNERS，文本节点里其实是 "Find owners"。
      // 逐字匹配于是一处都改不到，报出来是「这个变异体没生效」——
      // 采集和注入读的是两种表示。（注意：这段在模板字符串里，不能出现反引号。）
      const lower = cfg.target.toLowerCase();
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      const hits = [];
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeValue && n.nodeValue.toLowerCase().indexOf(lower) >= 0) hits.push(n);
      }
      for (const n of hits) {
        let v = "";
        let rest = n.nodeValue;
        let at = rest.toLowerCase().indexOf(lower);
        while (at >= 0) {
          v += rest.slice(0, at) + cfg.replacement;
          rest = rest.slice(at + cfg.target.length);
          at = rest.toLowerCase().indexOf(lower);
        }
        n.nodeValue = v + rest;
        state.applied += 1;
      }
      return;
    }
    if (cfg.op === "hide") {
      for (const el of document.querySelectorAll("button, a, input, select, textarea, [role=button]")) {
        const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        if (label.toLowerCase() === cfg.target.toLowerCase() && el.style.display !== "none") {
          el.style.display = "none";
          state.applied += 1;
        }
      }
      return;
    }
    if (cfg.op === "relink") {
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        if ((href === cfg.target || href.endsWith(cfg.target)) && href !== cfg.replacement) {
          a.setAttribute("href", cfg.replacement);
          state.applied += 1;
        }
      }
      return;
    }
    if (cfg.op === "dropOne") {
      const rows = document.querySelectorAll(cfg.target);
      if (rows.length > 1) {
        rows[rows.length - 1].remove();
        state.applied += 1;
      }
    }
  };

  const start = () => {
    apply();
    // 单页应用会不断重绘，改一次几秒钟就被盖掉——那会让变异体看起来"活下来"，
    // 而它其实从没生效过。
    new MutationObserver(() => apply()).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
`;
}

/** 注入之后读回来：这个变异体到底改了几处。0 处 = 没生效，不是"活下来"。 */
export interface MutationApplied {
  id: string;
  op: string;
  applied: number;
}
