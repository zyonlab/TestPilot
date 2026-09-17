/**
 * 步骤与断言里**有确定语义**的两件事：执行器照着做，不交给模型去猜。
 */

/**
 * 「打开 http://… 」这种纯导航步骤，直接 `page.goto`。
 *
 * 2026-09-15 Vikunja：步骤「打开 http://localhost:3456/login」交给 `aiAction`，Midscene 规划出
 * `{"type":"Navigate"}`，而它的动作表里没有这个类型——`Action type 'Navigate' not found`，用例当场红。
 * 去一个地址没有任何需要看屏幕判断的地方，本来就不该花一次模型调用。
 *
 * 只认**整步就是导航**的（「打开 X 并点击 Y」仍交给模型），且只认同源地址——
 * 执行不离开被测产品，外站地址交回模型，由它按老规矩处理（或失败）。
 */
const NAV = /^\s*(?:打开|访问|前往|进入|跳转到|导航到|open|visit|go to|navigate to)\s*[「"'`]?((?:https?:\/\/)[^\s」"'`，,。；;]+|\/[^\s」"'`，,。；;]*)[」"'`]?\s*[。.]?\s*$/i;

export function navigationTarget(step: string, currentUrl: string): string | undefined {
  const m = NAV.exec(step);
  if (!m) return undefined;
  try {
    const here = new URL(currentUrl);
    // 句末的英文句点不是地址的一部分（「Open http://x/teams.」）。
    const to = new URL(m[1]!.replace(/\.+$/, ""), here);
    if (!["http:", "https:"].includes(to.protocol) || to.origin !== here.origin) return undefined;
    return to.href;
  } catch {
    return undefined;
  }
}

/**
 * 一条自称「开放问题 / 待确认」的断言，**不是判决**。
 *
 * 2026-09-15 Vikunja C-S02-01：断言写「开放问题：规则包称首页有 6 条任务……不作为失败判据」，
 * 执行器照样把它交给 `aiAssert`，模型如实判「这句话为假」，一条其余 4 个判据全过的用例因此红。
 * 作者已经明说了这不是判据；判决层要尊重这个声明，把它记下来，但不据此判成败。
 * 只认显式标记（句首的「开放问题：」「待确认：」「【待确认」，或句中的「不作为失败判据」），不猜。
 */
const OPEN = /^\s*(?:开放问题|待确认|open question)\s*[：:]|^\s*【待确认|不作为失败判据|not a failure criterion/i;

export const isOpenQuestion = (statement: string): boolean => OPEN.test(statement);
