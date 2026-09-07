import { useState } from "react";
import { Button, EmptyState, ErrorCard, Select } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 覆盖矩阵：**gold checklist × 生成的用例**，命中 / 遗漏 / 多余三色。
 *
 * `03 §3` 模式①（拆解调试）点名要它，US-16 AC-16.1 也是它，而它此前**根本不存在**——
 * `grep 矩阵` 全仓零命中。打分的那条路一直是通的（`POST /api/evals/score`，
 * `server/src/evals.ts` 的 `scoreRun`），只是从来没有界面调用过它。
 *
 * 为什么落在「迭代评测」这一屏而不是画布上：`03 §3` 写的入口是「画布上 pin `plan.*` 子图」，
 * 而 `00-文档地图` 在 2026-09-01 把画布降级成了「运行」的详情。
 * 「这套 harness 拆得对不对」属于「这套 harness 好不好」，家在这里。
 * 画布那条路没有被堵——这一屏问的是同一件事，只是不必先找到那张图。
 *
 * **矩阵的三种颜色对应三种处置，不是三种严重程度**：
 *   命中 → 不用管
 *   遗漏 → 清单里有、这次没拆出来，补一条用例或改拆解提示词
 *   多余 → 拆出来了、清单里没有，要么是清单不全，要么是拆过头了
 * 最后一种最容易被当成噪声划掉，而它恰恰是唯一能反过来修正清单的信号。
 */
interface Row {
  id: string;
  title: string;
  heldOut: boolean;
  by: string[];
  reach: "hit" | "miss";
}
interface Score {
  coverage: number;
  cases: number;
  matrix?: { gold: Row[]; extras: Array<{ id: string; title: string }> };
  heldOut?: { coverage: number };
}

export function CoverageMatrix({ runs }: { runs: Array<{ id: string; label: string }> }) {
  const t = useT();
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState<Score | null>(null);

  const score1 = async () => {
    if (!runId) return;
    setBusy(true);
    setError("");
    setScore(null);
    try {
      const res = await fetch(`${API_BASE}/api/evals/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wfRunId: runId }),
      });
      const body = (await res.json()) as { score?: Score; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setScore(body.score ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gold = score?.matrix?.gold ?? [];
  const hit = gold.filter((g) => g.reach === "hit").length;
  const miss = gold.length - hit;
  const extras = score?.matrix?.extras ?? [];

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-none text-[0.875rem] font-medium">{t("matrix.title")}</h3>
        <Select value={runId} onChange={(e) => setRunId(e.target.value)} className="w-[16rem]">
          <option value="">{t("matrix.pickRun")}</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
        <Button variant="primary" disabled={!runId || busy} onClick={() => void score1()}>
          {busy ? t("matrix.scoring") : t("matrix.score")}
        </Button>
      </div>
      <p className="mt-1.5 max-w-[68ch] text-[0.6875rem] leading-relaxed text-muted-foreground">
        {t("matrix.why")}
      </p>

      {error && <ErrorCard className="mt-3" reason={error} onRetry={() => void score1()} />}

      {score && (
        <>
          {/* 数字在矩阵之前：人先要知道「够不够」，再去看「差在哪几条」。 */}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-y border-border py-2 font-mono text-[0.75rem]">
            <span>
              <span className="text-muted-foreground">{t("matrix.coverage")} </span>
              <b className="text-[1.0625rem] text-foreground">{Math.round(score.coverage * 100)}%</b>
            </span>
            {score.heldOut && (
              <span className="text-muted-foreground" title={t("matrix.heldOutWhy")}>
                {t("matrix.heldOut")} {Math.round(score.heldOut.coverage * 100)}%
              </span>
            )}
            <span className="text-ok">{t("matrix.hit", { n: hit })}</span>
            <span className={cn(miss ? "text-warn" : "text-muted-foreground")}>
              {t("matrix.miss", { n: miss })}
            </span>
            <span className={cn(extras.length ? "text-chat" : "text-muted-foreground")}>
              {t("matrix.extra", { n: extras.length })}
            </span>
            <span className="ml-auto text-muted-foreground">{t("matrix.cases", { n: score.cases })}</span>
          </div>

          <div className="mt-2 max-h-[26rem] overflow-auto">
            <table className="w-full text-[0.75rem]">
              <thead className="sticky top-0 bg-card">
                <tr>
                  <th className="w-[6rem] px-2 py-1.5 text-left font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
                    {t("matrix.colGold")}
                  </th>
                  <th className="px-2 py-1.5 text-left font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
                    {t("matrix.colItem")}
                  </th>
                  <th className="px-2 py-1.5 text-left font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
                    {t("matrix.colBy")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {gold.map((g) => (
                  <tr
                    key={g.id}
                    className={cn(
                      "border-b border-border align-top last:border-0",
                      g.reach === "hit" ? "bg-ok-soft/40" : "bg-warn-soft/50",
                    )}
                  >
                    <td className="px-2 py-1.5 font-mono text-[0.6875rem]">
                      <span className={g.reach === "hit" ? "text-ok" : "text-warn"}>{g.id}</span>
                      {/* 留出集的那几条单独标：它们从不参与调优，一个跟着改提示词就能涨的数说明不了什么。 */}
                      {g.heldOut && (
                        <span className="ml-1 text-faint" title={t("matrix.heldOutWhy")}>
                          ◦
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-ink2">{g.title}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {g.by.length ? g.by.join(" · ") : <span className="text-warn">{t("matrix.none")}</span>}
                    </td>
                  </tr>
                ))}
                {/* 多余的那些接在清单后面，同一张表——它们和清单是同一个问题的两半：
                    「该测的测了没有」和「测的都是该测的吗」。分成两张表，人会只看第一张。 */}
                {extras.map((x, i) => (
                  <tr key={`x${i}`} className="border-b border-border bg-chat-soft/40 align-top last:border-0">
                    <td className="px-2 py-1.5 font-mono text-[0.6875rem] text-chat">{t("matrix.extraTag")}</td>
                    <td className="px-2 py-1.5 text-ink2">{x.title}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{t("matrix.extraWhy")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!score && !error && !busy && (
        <EmptyState className="mt-3" title={t("matrix.emptyTitle")} body={t("matrix.emptyWhy")} />
      )}
    </div>
  );
}
