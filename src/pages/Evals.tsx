import { useEffect } from "react";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";
import { useWf } from "@/lib/wf";
import { CoverageMatrix } from "@/components/CoverageMatrix";
import { MigratedToPenguin } from "@/components/MigratedToPenguin";

/**
 * Paired evaluation.
 *
 * Two arms of the same graph, differing by one switch, scored against the same checklist
 * and subtracted. The page shows both numbers and the significance reading side by side,
 * because a delta without"could this be chance" is not a result.
 */
/**
 * **v3：这一屏只剩覆盖矩阵，因为另外那半边不再由这台机器回答。**
 *
 * 上面那段英文注释描述的配对评测——两臂、消融开关、显著性读数、critic 提的建议、
 * `evals/*.json` 的定义、变异面板——问的都是「**这一版 harness 比上一版好不好**」，
 * 而 v3 把 harness 层整个换成了 PenguinHarness（`docs/v3/history/00-架构.md` §1/§2）：
 * benchmark 目录、scoreboard、held-out、frozen baseline 都在那边，
 * `paired_eval` / `mutate_and_detect` 变成 MCP 工具，**且配对评测刻意绕过 agent**
 * （§3 P1）。在这里再画一份两臂对比，画的会是另一台机器上的数。
 *
 * 覆盖矩阵留下，因为它问的是**另一个问题**：「这套 harness 把这一次的规格拆得对不对」
 * ——gold checklist × 这次生成的用例，命中 / 遗漏 / 多余。它读的是这台机器自己的产物，
 * 而且它是复核之前该看的那一眼：一个拆都拆不对的版本，比上一版好也没用
 * （这句是原来那段注释的原话，它在这次改动之后仍然成立，只是"下面那些"搬走了）。
 */
export function EvalsPage() {
  const t = useT();
  const { load } = useWf();
  const wfRuns = useWf((st) => st.runs);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <TopBar title={t("nav.evals")} hint={t("eval.subtitle")} />
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          <CoverageMatrix
            runs={wfRuns.map((r) => ({
              id: r.id,
              label: `${r.graphId} · ${new Date(r.startedAt).toLocaleString()} · ${r.id.slice(-6)}`,
            }))}
          />
          {/*
            配对评测与变异搬去哪了，要在原地说清楚。
            一个只剩一张表的页面，如果不说另外那半边去了哪，人只会认为功能被删了。
          */}
          <MigratedToPenguin bare />
        </div>
      </div>
    </>
  );
}
