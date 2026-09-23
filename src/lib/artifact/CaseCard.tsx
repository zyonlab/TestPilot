import {LifecycleDetail} from '@/components/workbench/LifecycleDetail';
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { Field, Chip } from "./Field";
import { describeOracle, tierDelivered } from "./oracle";
import { METHOD_KEY, TIER_KEY, type ArtifactCase } from "./types";

/**
 * 一条文本用例，按测试评审要的四要素画全：**前置 / 数据 / 步骤 / 断言**。
 *
 * 此前界面只交出「标题 + 步骤 + 一句期望」，而数据里 40/40 有前置条件、38/40 有机器判据、
 * 36/40 说得出自己覆盖了哪条状态转移。一个复核者拿着三分之一的信息，是没法签字的。
 *
 * 断言画两行是有意的：`expected` 是给人读的一句话，`oracle` 是执行时程序真正去查的东西。
 * 两者不一致的用例最危险——它读起来在验 A，实际在验 B——而不并排放，没人看得出来。
 */

export function CaseMeta({
  kase,
  onFilterMethod,
}: {
  kase: ArtifactCase;
  onFilterMethod?: (m: string) => void;
}) {
  const t = useT();
  const claimed = kase.tier;
  const delivered = kase.oracle ? tierDelivered(kase.oracle) : 3;
  const mismatch = claimed < delivered;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Chip>{kase.storyId}</Chip>
      {kase.designMethod && (
        <Chip
          tone="plain"
          title={t(`${METHOD_KEY[kase.designMethod] ?? "artifact.method.unknown"}.why`)}
          onClick={onFilterMethod ? () => onFilterMethod(kase.designMethod) : undefined}
        >
          {t(METHOD_KEY[kase.designMethod] ?? "artifact.method.unknown")}
        </Chip>
      )}
      <Chip
        tone={mismatch ? "warn" : kase.oracle ? "good" : "plain"}
        title={
          mismatch
            ? t("artifact.tierMismatch", { claimed, delivered })
            : kase.oracle
              ? t("cases.tierBacked")
              : t("cases.tierUnbacked")
        }
      >
        {t(TIER_KEY[kase.tier] ?? "artifact.tier3")}
      </Chip>
      {kase.priority ? (
        <Chip tone={kase.priority === "P0" ? "bad" : kase.priority === "P1" ? "warn" : "plain"}>
          {kase.priority}
        </Chip>
      ) : (
        // 候选用例没有看板优先级。硬编码一个 P2 是在编造事实——说「还没有」才是真的。
        <Chip title={t("artifact.noPriorityWhy")}>—</Chip>
      )}
      {kase.code && <Chip tone="good">{t("review.hasCode")}</Chip>}
      {kase.degraded && <Chip tone="warn">{t("review.degraded")}</Chip>}
      {kase.codeBlocked && <Chip tone="bad">{t("artifact.codeBlocked")}</Chip>}
    </div>
  );
}

/**
 * 展开后的正文。只读——编辑仍然由调用方自己的表单负责，因为「改」和「读」的权限、
 * 保存时机、脏数据处理都不一样，硬揉进一个组件只会让两边都别扭。
 */
export function CaseBody({
  kase,
  onOpenTransition,
}: {
  kase: ArtifactCase;
  /** 点覆盖的转移时跳到产品地图上那条边。 */
  onOpenTransition?: (from: string, to: string) => void;
}) {
  const t = useT();
  // 每一段带 id，好让门禁 finding 能把读者的视线送到它挑毛病的那一段——
  // 前置、方法、覆盖这三样没有输入框，闪一下那一段是唯一能做的定位。
  const fid = (f: string) => `field-${f}-${kase.caseId}`;
  return (
    <div className="space-y-1.5">
      <Field label={t("artifact.precondition")} empty={t("artifact.noPrecondition")} id={fid("precondition")}>
        {kase.precondition.length > 0 && (
          <ul className="space-y-0.5">
            {kase.precondition.map((p, i) => (
              <li key={i} className="list-disc marker:text-muted-foreground/60" style={{ marginLeft: "1em" }}>
                {p}
              </li>
            ))}
          </ul>
        )}
      </Field>

      <Field label={t("artifact.data")} empty={t("artifact.noData")} tone="muted">
        {(() => {
          // 测试数据目前没有独立字段，只能从步骤里的 ${env.X} / ${secret.X} 占位符看出来。
          // 认不出来时说「步骤里内联」，而不是假装这条用例没有数据——它有，只是硬编码了。
          const refs = new Set<string>();
          for (const s of [...kase.steps, ...kase.precondition])
            for (const m of s.matchAll(/\$\{(env|secret)\.([A-Za-z0-9_]+)\}/g)) refs.add(`${m[1]}.${m[2]}`);
          if (!refs.size) return undefined;
          return (
            <div className="flex flex-wrap gap-1">
              {[...refs].map((r) => (
                <Chip key={r} tone={r.startsWith("secret") ? "warn" : "plain"}>
                  {r}
                </Chip>
              ))}
            </div>
          );
        })()}
      </Field>

      <Field label={t("artifact.steps")} empty={t("artifact.noSteps")} id={fid("steps")}>
        {kase.steps.length > 0 && (
          <ol className="space-y-0.5">
            {kase.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-4 shrink-0 text-right font-mono text-[0.6875rem] text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">{s}</span>
              </li>
            ))}
          </ol>
        )}
      </Field>

      <Field label={t("artifact.expected")} empty={t("artifact.noExpected")} id={fid("expected")}>
        {kase.expected && <span>{kase.expected}</span>}
      </Field>

      <Field
        label={t("artifact.oracle")}
        empty={t("artifact.noOracle")}
        tone={kase.oracle ? "normal" : "warn"}
      >
        {kase.oracle && (
          <span className="font-mono text-[0.75rem] text-ok">{describeOracle(kase.oracle, t)}</span>
        )}
      </Field>

      <Field label={t("artifact.covers")} empty={t("artifact.noCovers")} tone="muted" id={fid("covers")}>
        {kase.covers && kase.covers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {kase.covers.map((c) => {
              const [from, to] = c.split("->");
              const clickable = !!(onOpenTransition && from && to);
              return (
                <Chip
                  key={c}
                  tone="plain"
                  title={clickable ? t("artifact.coversOpen") : undefined}
                  onClick={clickable ? () => onOpenTransition!(from!, to!) : undefined}
                >
                  {c}
                </Chip>
              );
            })}
          </div>
        )}
      </Field>

      {/*
        清理步骤单独一段，而且**空的时候也画**。
        一条会写数据的用例如果不收拾自己，它会毒化它以后的每一次运行——第二次跑面对的
        产品和第一次不同，而这个差别一直看不见，直到某个计数断言毫无道理地挂掉。
        实测踩过：一批「新增主人」的用例反复跑，冻结基线从 10 个 owner 涨到 13 个。
      */}
      <LifecycleDetail contract={kase.lifecycle}/>
      <Field label={t("artifact.cleanup")} empty={t("artifact.noCleanup")} tone="muted">
        {!!kase.postSteps?.length && (
          <ol className="space-y-0.5">
            {kase.postSteps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-4 shrink-0 text-right font-mono text-[0.6875rem] text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">{s}</span>
              </li>
            ))}
          </ol>
        )}
      </Field>

      {kase.requirementId && (
        <Field label={t("artifact.requirement")}>
          <span className="font-mono text-[0.75rem]">{kase.requirementId}</span>
        </Field>
      )}
    </div>
  );
}

/** 折叠状态下的一行：标题 + 元信息 + 期望摘要。 */
export function CaseHeadline({ kase, expanded }: { kase: ArtifactCase; expanded?: boolean }) {
  const t = useT();
  return (
    <div className="min-w-0">
      <span className={cn("font-display text-[0.875rem]", expanded ? "text-foreground" : "text-foreground")}>
        {kase.title}
      </span>
      <div className="mt-1">
        <CaseMeta kase={kase} />
      </div>
      {!expanded && (
        <div className="mt-1 truncate text-[0.75rem] text-muted-foreground">
          {t("artifact.expectedArrow")} {kase.expected}
        </div>
      )}
    </div>
  );
}
