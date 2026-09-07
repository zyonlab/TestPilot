/**
 * 打开 / 关闭一张物料卡。
 *
 * 没有路由器了，所以没有 `navigate`。这两个函数就是全部的"导航"：地址里只有一个问题——
 * **哪张卡开着**。写 hash 而不是塞进某个 store，是为了让「去看那批用例」仍然是一个可以
 * 发出去的链接。
 */
/**
 * 打开一张卡也意味着**别的浮层该让位**。
 *
 * 设置是一个抽屉，而「新建项目」就长在它里面。创建成功后跳去用例卡，卡片在抽屉底下打开——
 * 人看到的还是设置，得先自己关掉才发现事情已经成了。所以这两个函数除了改地址，
 * 还广播一次"导航发生了"，由工作台负责收起盖在上面的东西。
 */
const announce = () => window.dispatchEvent(new CustomEvent("tp:navigated"));

/**
 * 换落点，**保住 `run`**——和 `App.tsx` 的 `go()` 同一条规矩。
 *
 * 之前这里是 `#/?open=${id}`，把地址里其余参数一并扔掉。于是同一个应用里
 * 有三套「保哪些参数」的写法：`go()` 保 `run`、这里一个不保、
 * `useSectionParam` 全清（那一条的后果更狠，点设置分节会把人踢回复核队列）。
 *
 * 三套里两套是错的，而错法都一样：**地址就是这个应用的全部状态**，
 * 一个只有一个地址的应用，扔参数等于扔状态。人正看着某一次运行，
 * 从产品地图切到物料，那一次运行悄悄变回「最近那一次」，界面不说。
 */
export const openCard = (id: string): void => {
  const [path, query] = window.location.hash.split("?");
  const keep = new URLSearchParams();
  const run = new URLSearchParams(query ?? "").get("run");
  if (run) keep.set("run", run);
  keep.set("open", id);
  window.location.hash = `${path || "#/"}?${keep}`;
  announce();
};

export const closeCard = (): void => {
  window.location.hash = "#/";
  announce();
};

/**
 * 打开画布，停在某一次工作流运行上。
 *
 * 画布不再是左导航里的一项——它是「运行」那一屏的**详情**，就像原型里
 * 从运行列表点进 `运行 · wf-xxx`。所以「打开」这个动作必须真的把人送过去：
 * 此前那颗按钮只是把这次运行选进 store，人留在列表上，什么都没发生。
 */
export const openRunOnCanvas = (wfRunId: string): void => {
  window.location.hash = `#/?open=canvas&run=${wfRunId}`;
  announce();
};
