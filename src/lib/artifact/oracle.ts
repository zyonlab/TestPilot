import type { MachineOracle } from "./types";

/**
 * 把机器判据说成人话。
 *
 * harness 包里有一份 `describeOracle`，但它把中文写死在领域层——界面切到 English
 * 之后那句话还是中文。这一份走 i18n，参数化，是给人看的那一份。
 *
 * 为什么值得单独说：`oracle` 才是判决的真正依据。`expected` 是给人读的一句话，
 * 执行时程序看的是这里。两者不一致的用例是最危险的一种——它读起来在验 A，实际在验 B。
 */
export function describeOracle(
  o: MachineOracle,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (o.kind) {
    case "text":
      return t("artifact.oracle.text", { v: o.value });
    case "noText":
      return t("artifact.oracle.noText", { v: o.value });
    case "url":
      return t("artifact.oracle.url", { v: o.value });
    case "count":
      return t(
        o.op === "gte"
          ? "artifact.oracle.countGte"
          : o.op === "lte"
            ? "artifact.oracle.countLte"
            : "artifact.oracle.countEq",
        { v: o.value, n: o.n },
      );
    case "delta":
      return t(
        o.direction === "increased"
          ? "artifact.oracle.deltaUp"
          : o.direction === "decreased"
            ? "artifact.oracle.deltaDown"
            : "artifact.oracle.deltaFlat",
        { v: o.value, by: o.by ?? "" },
      );
    case "judge": {
      const samples = o.samples ?? 3;
      return t("artifact.oracle.judge", { n: o.criteria.length, samples, minPass: o.minPass ?? Math.floor(samples / 2) + 1, criteria: o.criteria.join(" / ") });
    }
    case "api":
      return t("artifact.oracle.api", {
        path: o.path,
        op: o.op,
        v: o.value === undefined ? (o.by !== undefined ? String(o.by) : "") : String(o.value),
      });
    default:
      return "";
  }
}

/**
 * 这条判据实际交付的是哪一档。
 *
 * 和 `tierOf`（harness 侧）同义：delta 要比较两次观察，是 2；其余是 1。
 * 界面用它来揭穿「声称 tier 1 但判据只能给 tier 2」这种不一致。
 */
export const tierDelivered = (o: MachineOracle): 1 | 2 | 3 =>
  o.kind === "judge" ? 3 : o.kind === "delta" || (o.kind === "api" && (o.op === "increased" || o.op === "decreased" || o.op === "unchanged")) ? 2 : 1;
