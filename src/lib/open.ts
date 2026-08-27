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

export const openCard = (id: string): void => {
  window.location.hash = `#/?open=${id}`;
  announce();
};

export const closeCard = (): void => {
  window.location.hash = "#/";
  announce();
};
