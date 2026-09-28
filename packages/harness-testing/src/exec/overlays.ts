import { z } from "zod";

/**
 * 被测产品里**常驻、可关闭、会挡住操作**的面板或弹窗（公告、引导、营销浮层……）。
 *
 * 2026-09-25 Hyperliquid 测试网：右下角公告面板盖住账户资产区，Withdraw、Perps Overview 在截图里不存在，
 * 两条用例（ACC-01-03、ACC-02-02）三轮探查都卡在这；准备器想在 setupSteps 里关它，重放又不稳。
 * 它是环境的事实，不是用例的步骤：由环境画像声明「看见什么字就说明它在」「怎么关」，执行器在登录后与
 * 重开入口页后关掉；某一步因定位失败时，如果它还在，就关掉再重试这一步一次。
 *
 * 哪个产品有哪些这样的面板是项目数据（环境 login.overlays），代码里不写任何具体面板。
 */
export const DismissibleOverlaySchema = z.object({
  id: z.string().min(1).max(60),
  /** 屏幕上出现这段文字即说明它还开着（逐字包含，大小写敏感）。 */
  present: z.string().min(1).max(200),
  /** 关掉它的**一个**界面动作，比如「点击右下角公告面板标题栏的关闭按钮」。 */
  close: z.string().min(1).max(300),
  /**
   * 可选：关闭按钮的 CSS 选择器。命中**恰好一个**元素、且它所在的块里有 present 那段文字时，直接点它，不交给模型找；
   * 否则退回 close 那句话。2026-09-25 实测：模型点公告面板的 × 大多点不中（「still visible after close」几乎每次都有）。
   */
  selector: z.string().min(1).max(300).optional(),
}).strict();
export type DismissibleOverlay = z.infer<typeof DismissibleOverlaySchema>;
export const DismissibleOverlaysSchema = z.array(DismissibleOverlaySchema).max(10);

/** 这一步的失败像不像「被挡住了 / 找不到」：只有这类失败才值得关浮层后重试。业务断言失败、取消都不算。 */
export function blockedByOverlay(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  if (/EXEC_CANCELLED|aborted|Target closed/i.test(message)) return false;
  // 「failed to locate … not present」：2026-09-27 C-MAR-01-04 收尾，杠杆弹窗没关，模型说元素列表里只有弹窗、没有 Market。
  return /Failed to plan actions|failed to locate|Element not found|Replanning \d+ times|locate: multiple elements|not found|not present|找不到|未找到|看不到|遮挡|covered|obscured|intercept/i.test(message);
}

export interface OverlayIo {
  text: () => Promise<string>;
  act: (instruction: string) => Promise<void>;
  settle: () => Promise<void>;
  log: (line: string) => void;
  /** 按选择器确定性地点一下；点到了返回 true。不提供就只用 close 那句话。 */
  clickSelector?: (selector: string, present: string) => Promise<boolean>;
  /** 测试可替换的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 最多等 waitMs 看文字是否消失。 */
async function gone(io: OverlayIo, present: string, waitMs = 5_000, stepMs = 500): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (!(await io.text()).includes(present)) return true;
    if (Date.now() >= until) return false;
    await (io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(stepMs);
  }
}

/** 关掉当前还开着的声明浮层。返回关掉了几个；关不掉的只记日志，不抛——它不是用例的判决。 */
export async function dismissOverlays(overlays: readonly DismissibleOverlay[], io: OverlayIo, reason: string): Promise<number> {
  let closed = 0;
  for (const o of overlays) {
    let text: string;
    try { text = await io.text(); } catch { return closed; }
    if (!text.includes(o.present)) continue;
    try {
      // 关面板有动画，文字要过一会儿才从页面上消失；没消失就再点一次（2026-09-25 实测：入口页第一次关后
      // 立刻复查仍「still visible」，而重开入口页时同一个动作一次就关掉了）。
      let still = true;
      for (let attempt = 1; attempt <= 2 && still; attempt++) {
        const clicked = o.selector && io.clickSelector ? await io.clickSelector(o.selector, o.present).catch(() => false) : false;
        if (!clicked) await io.act(o.close);
        await io.settle();
        still = await gone(io, o.present).then((g) => !g);
      }
      io.log(`overlay ${o.id} ${still ? "still visible after close" : "dismissed"} (${reason})`);
      if (!still) closed++;
    } catch (e) {
      io.log(`overlay ${o.id} close failed (${reason}): ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
  }
  return closed;
}
