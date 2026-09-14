import { z } from "zod";
import { ApplicabilitySchema, ClaimTypeSchema, DomainIdSchema, ModuleDefSchema, SourceRefSchema, type ProductRulePack, type Rule } from "./rules.js";
import type { ExplorationReport, Observation } from "./report.js";

/**
 * 规范产品模型（ProductModel v1），由代码从「规则包 + 探索回执」确定性整理。
 *
 * 这是 docs/v3/20 §4 里「证据→规范产品模型」那个缺失的中间产物。模型（planner）以后
 * 可以在它之上提 change proposal，但它本身不由模型写：每个功能的 verification 是
 * 从回执算出来的，规则的 supported/contradicted 是对着 UI 期望判出来的。
 *
 * 分开三件事：适用性（applicability）、验证状态（verification）、主张类型（claimType）。
 * 「已观察」和「符合要求」不是同一个布尔值。
 */
export const FeatureVerificationSchema = z.enum(["confirmed", "unverified", "blocked", "conflicted", "inconclusive"]);
export type FeatureVerification = z.infer<typeof FeatureVerificationSchema>;
export const RuleBindingStatusSchema = z.enum(["verified", "unverified", "blocked", "conflicted", "inconclusive", "not_explorable", "open"]);

export const ClaimSchema = z
  .object({
    id: z.string().min(1),
    featureId: DomainIdSchema,
    claimType: ClaimTypeSchema,
    statement: z.string().min(1),
    ruleId: DomainIdSchema.optional(),
    sourceRefs: z.array(DomainIdSchema).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    support: z.enum(["supported", "contradicted", "unresolved"]),
  })
  .strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const ProductModelSchema = z
  .object({
    schemaVersion: z.literal("product-model.v1"),
    rulePack: z.object({ id: DomainIdSchema, version: z.string(), hash: z.string() }).strict(),
    charterId: DomainIdSchema,
    modules: z.array(ModuleDefSchema),
    features: z.array(
      z
        .object({
          id: DomainIdSchema,
          moduleId: DomainIdSchema,
          name: z.string(),
          applicability: ApplicabilitySchema,
          verification: FeatureVerificationSchema,
          verificationReason: z.string(),
          ruleIds: z.array(DomainIdSchema),
          targetIds: z.array(z.string()),
          stateIds: z.array(z.string()),
          claimIds: z.array(z.string()),
        })
        .strict(),
    ),
    interactionMappings: z.array(z.object({ featureId: DomainIdSchema, targetId: z.string(), stateId: z.string(), route: z.string() }).strict()),
    ruleBindings: z.array(
      z
        .object({
          ruleId: DomainIdSchema,
          featureIds: z.array(DomainIdSchema),
          status: RuleBindingStatusSchema,
          reason: z.string(),
          evidenceRefs: z.array(z.string()),
        })
        .strict(),
    ),
    claims: z.array(ClaimSchema),
    conflicts: z.array(z.object({ id: z.string(), featureId: DomainIdSchema, ruleId: DomainIdSchema, expected: z.string(), observed: z.string(), evidenceRefs: z.array(z.string()) }).strict()),
    sources: z.array(SourceRefSchema),
    /**
     * 角色与生命周期原样从规则包带过来（2026-09-12）。
     *
     * 它们是**产品事实**，和模块、规则一条命：下游写故事时要照着认领角色、
     * 按主链定优先级，而下游只拿得到产品模型，拿不到规则包。
     */
    roles: z.array(z.object({ id: DomainIdSchema, name: z.string(), goal: z.string() }).strict()).default([]),
    lifecycle: z.array(z.object({ id: DomainIdSchema, name: z.string(), order: z.number(), featureIds: z.array(DomainIdSchema) }).strict()).default([]),
    summary: z.object({ features: z.number().int(), confirmed: z.number().int(), unverified: z.number().int(), blocked: z.number().int(), conflicted: z.number().int(), inconclusive: z.number().int().default(0) }).strict(),
  })
  .strict();
export type ProductModel = z.infer<typeof ProductModelSchema>;

const test = (re: string, s: string): boolean => { try { return new RegExp(re, "i").test(s); } catch { return false; } };

/**
 * 这次探索里，哪几条证据通道**根本没产生过东西**。
 *
 * 2026-09-11 在 app.hyperliquid.xyz 上实测：整页的 tab、勾选、下拉都是无 ARIA 属性、
 * class 名是构建哈希的 `div`，采集器一条选中态都取不到——于是每一条「切过去之后该控件
 * 变成选中」的期望都落空，产品模型把六条规则判成了 conflicted。而页面其实全部正常响应
 * （切 Limit 多出价格输入、勾 TP/SL 多出止盈价输入）。
 *
 * 「产品不对」和「我们看不见」必须分开：前者是缺陷，后者是我们的观测能力不足。
 * 判据是通道级的事实，不是逐条猜：整次探索一条 stateChanged 都没有，就说明这个产品上
 * 这条通道是瞎的，任何依赖它的期望只能是 inconclusive。
 */
export interface EvidenceChannels { controls: boolean; state: boolean; text: boolean }
export const channelsOf = (observations: Observation[]): EvidenceChannels => {
  const attempted = observations.filter((o) => o.status === "attempted");
  return {
    controls: attempted.some((o) => o.controlsAfter.length > 0),
    state: attempted.some((o) => (o.effect?.stateChanged ?? []).length > 0),
    text: attempted.some((o) => (o.effect?.textAdded ?? []).length > 0),
  };
};

/** 对着一次 attempted 观察判一条 ui-state 规则：分开「没满足」和「看不见」。 */
export function checkUiExpectation(rule: Rule, obs: Observation, channels: EvidenceChannels = { controls: true, state: true, text: true }): { missing: string[]; unobservable: string[] } {
  if (rule.verification.kind !== "ui-state") return { missing: [], unobservable: [] };
  const e = rule.verification.expect;
  const missing: string[] = [];
  const unobservable: string[] = [];
  const check = (kind: "controlsPresent" | "stateChanged" | "textPresent", patterns: string[], haystack: string[], live: boolean) => {
    for (const re of patterns) {
      if (haystack.some((h) => test(re, h))) continue;
      (live ? missing : unobservable).push(`${kind}:${re}`);
    }
  };
  check("controlsPresent", e.controlsPresent, obs.controlsAfter, channels.controls);
  check("stateChanged", e.stateChanged, obs.effect?.stateChanged ?? [], channels.state);
  check("textPresent", e.textPresent, obs.effect?.textAdded ?? [], channels.text);
  return { missing, unobservable };
}

/** 这一批激活的效果里，撞上了哪些闸门文案。空数组 = 没撞上。 */
function gatesIn(observations: Array<{ effect?: { controlsAdded?: string[]; textAdded?: string[] } }>, gateLabels: string[]): string[] {
  if (!gateLabels.length) return [];
  const hay = observations.flatMap((o) => [...(o.effect?.controlsAdded ?? []), ...(o.effect?.textAdded ?? [])]);
  return gateLabels.filter((g) => hay.some((h) => h.toLowerCase().includes(g.toLowerCase())));
}

export function buildProductModel(input: { pack: ProductRulePack; report: ExplorationReport }): ProductModel {
  const { pack, report } = input;
  const obsByFeature = new Map<string, Observation[]>();
  for (const o of report.observations) obsByFeature.set(o.featureId, [...(obsByFeature.get(o.featureId) ?? []), o]);
  const targetsByFeature = new Map<string, typeof report.targets>();
  for (const t of report.targets) targetsByFeature.set(t.featureId, [...(targetsByFeature.get(t.featureId) ?? []), t]);
  const plannedByFeature = new Map<string, typeof report.plannedTargets>();
  for (const p of report.plannedTargets) plannedByFeature.set(p.featureId, [...(plannedByFeature.get(p.featureId) ?? []), p]);

  const claims: ProductModel["claims"] = [];
  const conflicts: ProductModel["conflicts"] = [];
  const ruleBindings: ProductModel["ruleBindings"] = [];
  const conflictedFeatures = new Set<string>();
  const inconclusiveFeatures = new Set<string>();
  const channels = channelsOf(report.observations);

  for (const rule of pack.rules) {
    const attempted = rule.featureIds.flatMap((f) => (obsByFeature.get(f) ?? []).filter((o) => o.status === "attempted"));
    const blocked = rule.featureIds.flatMap((f) => (obsByFeature.get(f) ?? []).filter((o) => o.status === "blocked"));
    let status: z.infer<typeof RuleBindingStatusSchema>;
    let reason: string;
    const evidenceRefs = attempted.flatMap((o) => o.evidenceRefs);
    if (rule.verification.kind === "open-question") { status = "open"; reason = rule.verification.question; }
    else if (rule.verification.kind === "api") { status = attempted.length ? "not_explorable" : blocked.length ? "blocked" : "unverified"; reason = attempted.length ? `needs execution oracle: ${rule.verification.note}` : blocked.length ? blocked[0]!.reason ?? "blocked" : "no attempted observation"; }
    else if (!attempted.length) { status = blocked.length ? "blocked" : "unverified"; reason = blocked.length ? blocked[0]!.reason ?? "blocked" : "target not activated"; }
    else {
      const results = attempted.map((o) => ({ o, ...checkUiExpectation(rule, o, channels) }));
      const met = results.find((r) => !r.missing.length && !r.unobservable.length);
      // 「有一条期望确实落空」优先于「另一条看不见」：前者是可判的证据。
      const contradicted = results.every((r) => r.missing.length) ? results.find((r) => r.missing.length)! : undefined;
      if (met) { status = "verified"; reason = `ui expectation met in ${met.o.id}`; }
      else if (contradicted && rule.claimType !== "normative") {
        /**
         * **假设没被满足 ≠ 产品错了。**
         *
         * `conflicted` 是在指控产品有缺陷，那个指控只有**要求**（normative，背后有官方文档 /
         * 产品规格 / fixture 契约）才提得起。观察与假设提不起：假设说的是「我猜它该这样」，
         * 猜错了是猜的人错，不是产品错。
         *
         * 2026-09-13 实测：`REFERENCE-domain-perp.md` 的五条不变量搬进规则包时，
         * 校验逼着它们自报家门成 `hypothesis`（domain-reference 撑不起要求）——
         * 可这里不看 claimType，于是它们一落空就把 7 个功能判成了 conflicted，
         * 其中 `order.submit` / `position.list` 全在内。**校验挡住了包，模型这一侧没挡住。**
         *
         * 假设落空的正确归宿是**开放问题**：记成 inconclusive，理由写明它是一条假设。
         */
        status = "inconclusive";
        reason = `${rule.claimType} expectation not met (${contradicted.missing.join(", ")}) — a ${rule.claimType} claim cannot convict the product; it becomes an open question`;
        for (const f of rule.featureIds) inconclusiveFeatures.add(f);
      }
      else if (contradicted) {
        status = "conflicted";
        reason = `ui expectation missing: ${contradicted.missing.join(", ")}`;
        for (const f of rule.featureIds) conflictedFeatures.add(f);
        conflicts.push({
          id: `conflict-${rule.id}`,
          featureId: rule.featureIds[0]!,
          ruleId: rule.id,
          expected: JSON.stringify(rule.verification.expect),
          observed: JSON.stringify({ effect: contradicted.o.effect ?? null, controlsAfter: contradicted.o.controlsAfter.slice(0, 40) }),
          evidenceRefs: results.flatMap((r) => r.o.evidenceRefs),
        });
      } else {
        // 剩下的只可能是「期望依赖的通道在这个产品上取不到证据」。
        // 一条规则可以只有一半瞎：TP/SL 的面板确实弹出来了（控件通道可判），
        // 但「开关变成选中」取不到证据。半份证据不等于验证通过，所以整条记 inconclusive，
        // 理由里写清瞎的是哪一维——修观测能力还是改规则，读的人才判得出来。
        status = "inconclusive";
        const blind = [...new Set(results.flatMap((r) => r.unobservable))];
        reason = `evidence channel unavailable on this product: ${blind.join(", ")}`;
        for (const f of rule.featureIds) inconclusiveFeatures.add(f);
      }
    }
    ruleBindings.push({ ruleId: rule.id, featureIds: rule.featureIds, status, reason, evidenceRefs });
    for (const f of rule.featureIds)
      claims.push({
        id: `claim-${rule.id}-${f}`,
        featureId: f,
        claimType: rule.claimType,
        statement: rule.statement,
        ruleId: rule.id,
        sourceRefs: rule.sourceRefs,
        evidenceRefs,
        support: status === "verified" ? "supported" : status === "conflicted" ? "contradicted" : "unresolved",
      });
  }

  const features: ProductModel["features"] = pack.features.map((f) => {
    const obs = obsByFeature.get(f.id) ?? [];
    const found = targetsByFeature.get(f.id) ?? [];
    const planned = plannedByFeature.get(f.id) ?? [];
    const attempted = obs.filter((o) => o.status === "attempted");
    /**
     * 什么才算**确证**这个功能：一次点击，**有效果**，而且那个效果不是一道闸门。
     *
     * 两条都撞过：`order.margin-mode` 点出的是「建立连接」弹窗（闸门），
     * 而它的第二次点击**什么都没发生**——两条加起来仍被判成 confirmed。
     * 「点了两下」不是「功能成立」。反过来，`account.connect` 有一次点击真的把会话建起来了
     * （效果里出现 Place Order），一次闸门不该把它也拖下水，所以是**按观察逐条判**，不是整批判。
     */
    const withEffect = attempted.filter((o) => {
      const e = (o as { effect?: { controlsAdded?: string[]; stateChanged?: string[]; textAdded?: string[] } }).effect;
      return !!e && !!((e.controlsAdded?.length ?? 0) + (e.stateChanged?.length ?? 0) + (e.textAdded?.length ?? 0));
    });
    const clean = withEffect.filter((o) => !gatesIn([o] as never, pack.gateLabels).length);
    const gateNames = [...new Set(gatesIn(withEffect as never, pack.gateLabels))];
    const blocked = obs.filter((o) => o.status === "blocked");
    let verification: FeatureVerification;
    let verificationReason: string;
    // 判定顺序：冲突 > 已激活 > 找到了但还没轮到 > 找到了但全被阻断 > 只看 > 没找到。
    // 「找到了但被策略/前提阻断」是 blocked，不是 unverified——后者意味着再给预算就能验。
    const pendingFound = found.filter((t) => !obs.some((o) => o.targetId === t.stableId));
    /**
     * 声明了「点完屏幕上该出现什么」的目标：**以屏幕为准**。
     *
     * 2026-09-12：机器臂把下单链一路走通、点了弹窗里的确认键，这里据此判 confirmed，
     * 理由写的是「activated 1 target(s) with a recorded effect」——数的却是上一步
     * 「弹窗打开了」那个效果。同一时刻账户页上是「尚无开放仓位」：单没下成。
     * 用例判据早就只认屏幕（CLAUDE.md），功能判决不能还在认「有个控件响应了」。
     */
    const expectations = pack.targets.filter((t) => t.featureId === f.id && t.expectOnScreen.length);
    const linesOf = (o: Observation): string[] => {
      const e = (o as { effect?: { controlsAdded?: string[]; stateChanged?: string[]; textAdded?: string[] } }).effect;
      return [...(e?.textAdded ?? []), ...(e?.controlsAdded ?? []), ...(e?.stateChanged ?? [])];
    };
    const checked = expectations.map((t) => {
      const os = attempted.filter((o) => o.targetSpecId === t.id);
      const seen = os.flatMap(linesOf).find((line) => t.expectOnScreen.some((re) => test(re, line)));
      return { t, os, seen };
    });
    const missed = checked.filter(({ os, seen }) => os.length && !seen);
    /**
     * **声明了屏幕期望、却从没点过那个目标 → 不算确证。**
     *
     * `missed` 只数 attempted 的观察，于是「看见了但没点」落不进它，判决就滑到下面
     * 「有效果且不是闸门」那一支——而那个效果是**上一步**留下的。
     * 2026-09-12 实测第二次撞见同一件事的另一条路：`T-CONFIRM-ACT` 在回执里是
     * `observed_only / found_not_activated`（确认键被找到但没点），
     * `order.submit` 仍然判成 confirmed，理由还是那句泛泛的
     * 「activated 1 target(s) with a recorded effect」——它数的是 `Place Order` 把弹窗打开。
     * 期望写出来就是要去验的；没验过只能是「还没验」。
     */
    const untried = expectations.filter((t) =>
      !attempted.some((o) => o.targetSpecId === t.id)
      && (report.plannedTargets ?? []).some((p) => p.targetSpecId === t.id && p.status !== "not_found"));
    // 期望**被满足**时也要说清是屏幕上哪一行作的证——判决的分量全在那一行上。
    const met = checked.find(({ os, seen }) => os.length && seen);
    if (conflictedFeatures.has(f.id)) { verification = "conflicted"; verificationReason = "a rule's ui expectation was not met after activation"; }
    else if (inconclusiveFeatures.has(f.id) && attempted.length) { verification = "inconclusive"; verificationReason = `activated ${attempted.length} target(s), but the rule's evidence channel is not observable on this product`; }
    else if (missed.length) {
      /**
       * 屏幕上**没出现期望的**，但往往出现了**别的**——那句话才是产品给的答案。
       * 2026-09-12 实测：确认键点下去，屏幕上是
       * `Order could not match against any resting orders`（产品拒绝了这一单）。
       * 判决写「什么都没出现」会让人以为点击丢了；带上这句，读的人立刻知道下一步该查什么。
       */
      const said = missed.flatMap(({ os }) => os.flatMap((o) => {
        const e = (o as { effect?: { textAdded?: string[]; controlsAdded?: string[] } }).effect;
        return [...(e?.textAdded ?? []), ...(e?.controlsAdded ?? [])];
      })).filter((line) => !/^=+ 第 \d+ 屏 =+$/.test(line.trim()) && line.trim().length > 8);
      verification = "inconclusive";
      verificationReason = `activated ${missed.map((m) => m.t.id).join(", ")}, but the screen never showed ${missed[0]!.t.expectOnScreen.slice(0, 3).join(" / ")}`
        + (said.length ? `; the screen said: ${said[0]!.slice(0, 120)}` : "");
    }
    else if (attempted.length && !clean.length) {
      /**
       * 点是点了，但点出来的是一道**闸门**（「建立连接」「在钱包中确认」「确认下单」…），
       * 不是这个功能本身。`confirmed` 的意思必须是「这个功能被证实了」，
       * 而不是「有个控件响应了」——两者的差别就是这一条（docs/v3/24 §21）。
       */
      verification = "inconclusive";
      verificationReason = gateNames.length
        ? `activated ${attempted.length} target(s), but every effect stopped at a gate: ${gateNames.slice(0, 3).join(" / ")}`
        : `activated ${attempted.length} target(s), but nothing changed on the page`;
    }
    else if (met) { verification = "confirmed"; verificationReason = `activated ${met.t.id}; the screen showed: ${met.seen!.slice(0, 120)}`; }
    else if (untried.length) {
      verification = "unverified";
      verificationReason = `${untried.map((t) => t.id).join(", ")} was found but never activated, so what it should put on the screen (${untried[0]!.expectOnScreen.slice(0, 2).join(" / ")}) was never tested`;
    }
    else if (clean.length) { verification = "confirmed"; verificationReason = `activated ${clean.length} target(s) with a recorded effect that is not a gate`; }
    else if (pendingFound.length) { verification = "unverified"; verificationReason = "target seen but not activated (budget or order)"; }
    else if (blocked.length) { verification = "blocked"; verificationReason = [...new Set(blocked.map((o) => o.reason ?? "blocked"))].join("; "); }
    else if (found.length) { verification = "unverified"; verificationReason = "observe-only targets seen; behavior not exercised"; }
    else if (!planned.length) { verification = "unverified"; verificationReason = "no exploration target declared for this feature"; }
    else { verification = "blocked"; verificationReason = "target not found in scope: not observed ≠ not applicable"; }
    const observedClaims = attempted.map((o) => {
      const c: Claim = {
        id: `claim-obs-${o.id}`,
        featureId: f.id,
        claimType: "observed",
        statement: `Activating "${o.action?.target ?? o.targetId}" changed: +${o.effect?.controlsAdded.length ?? 0} controls, -${o.effect?.controlsRemoved.length ?? 0}, ${o.effect?.stateChanged.length ?? 0} state changes, ${o.effect?.textAdded.length ?? 0} text lines`,
        sourceRefs: [],
        evidenceRefs: o.evidenceRefs,
        support: "supported",
      };
      claims.push(c);
      return c.id;
    });
    return {
      id: f.id,
      moduleId: f.moduleId,
      name: f.name,
      applicability: f.applicability,
      verification,
      verificationReason,
      ruleIds: pack.rules.filter((r) => r.featureIds.includes(f.id)).map((r) => r.id),
      targetIds: found.map((t) => t.stableId),
      stateIds: [...new Set([...found.map((t) => t.stateId), ...attempted.flatMap((o) => (o.stateAfter ? [o.stateAfter] : []))])],
      claimIds: [...claims.filter((c) => c.featureId === f.id && c.ruleId).map((c) => c.id), ...observedClaims],
    };
  });

  const count = (v: FeatureVerification) => features.filter((f) => f.verification === v).length;
  return ProductModelSchema.parse({
    schemaVersion: "product-model.v1",
    rulePack: report.rulePack,
    charterId: report.charterId,
    modules: pack.modules,
    features,
    interactionMappings: report.targets.map((t) => ({ featureId: t.featureId, targetId: t.stableId, stateId: t.stateId, route: t.route })),
    ruleBindings,
    claims,
    conflicts,
    sources: pack.sources,
    roles: pack.roles.map((r) => ({ id: r.id, name: r.name, goal: r.goal })),
    lifecycle: [...pack.lifecycle].sort((a, b) => a.order - b.order).map((l) => ({ id: l.id, name: l.name, order: l.order, featureIds: l.featureIds })),
    summary: { features: features.length, confirmed: count("confirmed"), unverified: count("unverified"), blocked: count("blocked"), conflicted: count("conflicted"), inconclusive: count("inconclusive") },
  });
}

/** 产品模型的人类可读投影：模块→功能→验证状态→规则。 */
export function describeProductModel(m: ProductModel): string {
  const byModule = new Map<string, ProductModel["features"]>();
  for (const f of m.features) byModule.set(f.moduleId, [...(byModule.get(f.moduleId) ?? []), f]);
  const lines = [
    "===== 规范产品模型（代码整理，非模型自述） =====",
    `规则包 ${m.rulePack.id}@${m.rulePack.version}　功能 ${m.summary.features}：confirmed ${m.summary.confirmed} / unverified ${m.summary.unverified} / blocked ${m.summary.blocked} / conflicted ${m.summary.conflicted} / inconclusive ${m.summary.inconclusive}`,
  ];
  for (const mod of m.modules) {
    lines.push("", `【${mod.name}】(${mod.id})`);
    for (const f of byModule.get(mod.id) ?? []) {
      lines.push(`- ${f.name} (${f.id}) · 适用性 ${f.applicability} · 验证 ${f.verification}：${f.verificationReason}`);
      for (const rid of f.ruleIds) {
        const b = m.ruleBindings.find((x) => x.ruleId === rid)!;
        lines.push(`    · 规则 ${rid} → ${b.status}：${b.reason}`);
      }
    }
  }
  if (m.conflicts.length) lines.push("", "冲突（要求与观察不一致，两边证据都保留）：", ...m.conflicts.map((c) => `- ${c.ruleId} @ ${c.featureId}`));
  return lines.join("\n");
}
