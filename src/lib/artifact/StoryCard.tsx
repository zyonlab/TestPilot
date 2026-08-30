import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { Field, Chip } from "./Field";
import type { ArtifactStory } from "./types";

/**
 * 一条用户故事，画全。
 *
 * 「作为 X，我要 Y，以便 Z」不是格式洁癖：没有角色就说不出这条是为谁做的，没有收益就
 * 判断不了它值不值得测。schema 的注释里写得很清楚——「没有角色的条目不是用户故事，
 * 是界面事实」。数据侧一直照做（实测 8/8 有角色有收益），此前是界面把它吞了。
 *
 * 所以缺角色或缺收益时这里**明说**，而不是留白：留白看起来像「本来就没有」，
 * 说出来才是「这条有问题」。
 */
export function StoryTitle({ story, compact }: { story: ArtifactStory; compact?: boolean }) {
  const t = useT();
  const incomplete = !story.role || !story.benefit;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[11px] text-primary">{story.id}</span>
        <span className={cn("font-medium text-foreground", compact ? "text-[12.5px]" : "text-[13.5px]")}>
          {story.title}
        </span>
      </div>
      {story.role || story.benefit ? (
        <div className="mt-0.5 text-[11.5px] leading-[1.6] text-muted-foreground">
          {t("artifact.asRoleIWant", {
            role: story.role ?? t("artifact.roleUnknown"),
            what: story.title,
            benefit: story.benefit ?? t("artifact.benefitUnknown"),
          })}
        </div>
      ) : (
        // 两个都没有 = 这不是一条用户故事。说出来。
        <div className="mt-0.5 text-[11.5px] text-amber-600 dark:text-amber-400">
          {t("artifact.notAStory")}
        </div>
      )}
      {incomplete && (story.role || story.benefit) && (
        <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
          {!story.role ? t("artifact.missingRole") : t("artifact.missingBenefit")}
        </div>
      )}
    </div>
  );
}

export function StoryCard({
  story,
  caseCount,
  onOpenCases,
}: {
  story: ArtifactStory;
  /** 这条故事下有几条用例。0 是一个结论，不是一个空白。 */
  caseCount?: number;
  onOpenCases?: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2 border-b border-border/60 px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <StoryTitle story={story} />
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
          {story.activity && <Chip tone="accent" title={t("artifact.activityWhy")}>{story.activity}</Chip>}
          {story.flowId && <Chip title={t("artifact.flowWhy")}>{story.flowId}</Chip>}
          {story.requirementId && <Chip title={t("artifact.reqWhy")}>{story.requirementId}</Chip>}
          {caseCount !== undefined &&
            (caseCount > 0 ? (
              <Chip tone="plain" onClick={onOpenCases}>{t("artifact.nCases", { n: caseCount })}</Chip>
            ) : (
              <Chip tone="warn" title={t("artifact.noCasesWhy")}>{t("artifact.noCases")}</Chip>
            ))}
        </div>
      </div>

      <Field label={t("artifact.acceptance")} empty={t("artifact.noAcceptance")}>
        {story.acceptance.length > 0 && (
          <ul className="space-y-0.5">
            {story.acceptance.map((a, i) => (
              <li key={i} className="list-disc marker:text-muted-foreground/60" style={{ marginLeft: "1em" }}>
                {a}
              </li>
            ))}
          </ul>
        )}
      </Field>

      <Field label={t("artifact.source")} empty={t("artifact.noSource")} tone="muted">
        {story.source && (
          <span
            className={cn(
              "font-mono text-[11.5px]",
              story.sourceBy === "located" ? "" : "text-amber-600 dark:text-amber-400",
            )}
            title={t(`stories.sourceBy.${story.sourceBy ?? "claimed"}`)}
          >
            {story.sourceBy === "located" ? "" : "? "}
            {story.source.split("/").pop()}
          </span>
        )}
      </Field>
    </div>
  );
}
