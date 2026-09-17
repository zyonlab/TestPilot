/**
 * Types the executor and the gateway both speak. They used to live in the gateway's
 * db.ts/config.ts; they moved here because the executor now runs in another process and
 * the wire contract has to have one owner.
 */

export interface ChainAssertion {
  // txSubmitted: the wallet sent ≥/=/≤ N successful (mined, status 1) transactions this run.
  kind: "erc20Balance" | "nativeBalance" | "txSubmitted";
  account?: string; // default: the test wallet
  token?: string; // ERC-20 contract (for erc20Balance)
  decimals?: number; // token decimals for display/compare (default 18; USDC=6)
  op: "increased" | "decreased" | "changed" | "gte" | "lte" | "eq";
  value?: string; // human-unit threshold (balance) or count (txSubmitted) for gte/lte/eq
  label?: string; // display label
}

export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  headers?: Record<string, string>; // captured auth headers (e.g. Authorization from API login)
}

export interface OracleCheck {
  assertion: string; // the expected condition that was verified
  /** `unobservable`：这次没量到，不是产品错了（`exec/oracle.ts` 的 OracleVerdict）。 */
  status: "pass" | "fail" | "unobservable";
  detail?: string;
  /**
   * What settled it. Worth recording on every run: "passed" means two different things
   * depending on whether a program checked it or a model looked at a screenshot, and a
   * report that hides the difference cannot be used to argue about tier distribution.
   */
  decidedBy?: "machine" | "judge";
  /** judge 判据的采样统计（几次、几次全部成立、每条条件成立几次、意见是否分歧）。 */
  judge?: import("./exec/oracle.js").JudgeStats;
  /**
   * 这条判据在**步骤跑之前**是不是就已经成立了。
   *
   * 「通过」也有两种：一种是这些步骤把产品带到了判据要求的状态，另一种是判据在
   * 什么都没做的时候就已经成立——后者的绿是免费的，它证明不了这条用例的标题。
   * 2026-09-13 实测 `trade-panel.order-entry` 10 条，**6 条属于后者**：
   * TC-011「切换到 Sell / Short」的判据是 `text:"Sell / Short"`，而同模块的 TC-013
   * 的全部内容就是证明「两个方向按钮始终都在」。
   *
   * 不改判决——判据成立就是成立。记下来，让报告能把这两种绿分开。
   * 只对一份快照就能判的那几种（text/noText/count）有意义；关系型判据天然要比前后。
   */
  heldBefore?: boolean;
}

export type VisualStatus = "new_baseline" | "match" | "diff";
export interface VisualDiff {
  stepIdx: number;
  status: VisualStatus;
  mismatchPct: number;
  baselineRef?: string; // artifact filename served by /api/artifacts/:name
  currentRef?: string;
  diffRef?: string;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
}
