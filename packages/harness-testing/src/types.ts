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
