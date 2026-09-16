/**
 * 模块树提案的机检（docs/v3/history/24 §7）。
 *
 * 模块树是**产品事实**，不是推导产物，所以它的形状和 gold 一样：模型提议、服务端机检、人冻结。
 * 这里只做机器判得了的那一半——「这棵树切得对不对」要人看，「这棵树有没有漏掉材料、
 * 是不是一张伪装成树的清单」机器能查。
 *
 * 每一条检查都由 2026-09-11 双臂对照里真实抓到的缺陷支撑，不是想出来的规矩。
 */

export interface ModuleProposal {
  id: string;
  name?: string;
  parentId?: string | null;
  purpose?: string;
  /** 材料里的段 id，例如 `observed-zh.md#4`。 */
  evidence?: string[];
  /**
   * 这个模块**认领产品模型里的哪些功能**（2026-09-12）。
   *
   * 重新切树是这个节点的全部意义，但功能是挂在**上一棵树**的模块 id 上的：
   * 切完不重新认领，功能就全成了孤儿。实测：模型提了一棵 `m-account / m-market …`
   * 的新树，**21 个功能一个都没接住**，于是每个故事单元 `features=0 / rules=0`——
   * 领域规则整份没流到用户故事节点，模型只能看着模块名写故事。
   * 留空表示「按上一棵树的归属推断」，那只在 id 没变时才成立。
   */
  featureIds?: string[];
}

/** 只取故事里和模块相关的那几个字段，免得这个模块反过来依赖 casegen 的类型。 */
export interface StoryRef {
  id: string;
  moduleIds?: string[];
  evidence?: string[];
}

export type PlanSeverity = "error" | "warn" | "info";

export interface PlanFinding {
  code: string;
  severity: PlanSeverity;
  message: string;
  moduleId?: string;
  storyId?: string;
  sectionId?: string;
}

export interface ModulePlanInput {
  modules: ModuleProposal[];
  stories?: StoryRef[];
  /** 材料里全部可引用的段 id。没给就不查「有没有落点」——查不了的东西不装作查过。 */
  sections?: string[];
  /**
   * 显式声明不在范围内的材料段，以及为什么。
   *
   * 没有这个出口，「每段都要有落点」就会变成唠叨：有些段天然没有模块对应物
   * （`domain-perp-zh.md#14` 讲的是「这类页面最容易被测错的四件事」，那是写用例的规矩，
   * 不是产品的一块）。**要求的是给个交代，不是要求每段都变成模块**——
   * 说「不在范围内，因为 X」和说「它属于模块 M」一样算交代过了，说不出来才是漏。
   */
  outOfScope?: Array<{ sectionId: string; reason: string }>;
  /**
   * 叶子模块平均故事数的下限。
   *
   * 低于它说明树没有比故事更粗：叶子和故事 1:1 的时候，这棵树没有在提供结构，
   * 只是把故事换了个名字排了一遍。默认 1.5——实测机器臂 0.86、参照臂 1.25，两臂都没过。
   */
  minLeafFanout?: number;
}

const DEFAULT_MIN_LEAF_FANOUT = 1.5;

/** 叶子＝没有任何模块把它当 parent。 */
export function leafModules(modules: ModuleProposal[]): ModuleProposal[] {
  const parents = new Set(modules.map((m) => m.parentId).filter(Boolean) as string[]);
  return modules.filter((m) => !parents.has(m.id));
}

export function checkModulePlan(input: ModulePlanInput): PlanFinding[] {
  const { modules, stories = [], sections, outOfScope = [], minLeafFanout = DEFAULT_MIN_LEAF_FANOUT } = input;
  const out: PlanFinding[] = [];
  const add = (code: string, severity: PlanSeverity, message: string, extra: Partial<PlanFinding> = {}) =>
    out.push({ code, severity, message, ...extra });
  const ids = new Set(modules.map((m) => m.id));

  for (const m of modules) {
    if (!ids.has(m.id)) continue;
    if (m.parentId && !ids.has(m.parentId))
      add("module_parent_unknown", "error", `parentId ${m.parentId} 不是任何一个模块`, { moduleId: m.id });
    if (m.parentId === m.id) add("module_parent_self", "error", "模块的 parentId 指向自己", { moduleId: m.id });
    /**
     * **假层级**：id 带点号，看起来像子模块，`parentId` 却是空的。
     *
     * 2026-09-11 实测：机器臂 7 个模块 7 个都这样（`market.header` / `trade.panel` /
     * `account.positions`，而 `market` / `trade` / `account` 作为模块根本不存在）。
     * 不先查这一条，下面所有「叶子」的计算都是假的——一棵全是根的树，每个节点都是叶子。
     */
    const dot = m.id.lastIndexOf(".");
    if (dot > 0) {
      const prefix = m.id.slice(0, dot);
      if (!m.parentId)
        add("module_fake_hierarchy", "error",
          `id 带点号却没有 parentId：它看起来是 ${prefix} 的子模块，但没有声明。层级要写在 parentId 里，不是写在名字里`,
          { moduleId: m.id });
      else if (m.parentId !== prefix)
        add("module_id_parent_mismatch", "warn",
          `id 的点号前缀是 ${prefix}，parentId 却是 ${m.parentId}：两处说的不是同一个父模块`,
          { moduleId: m.id });
    }
    if (!m.evidence?.length)
      add("module_without_evidence", "warn", "模块没有引用任何材料：说不出它是从哪一段看出来的", { moduleId: m.id });
    else if (sections)
      for (const e of m.evidence)
        if (!sections.includes(e))
          add("module_evidence_unknown", "warn", `引用了材料里不存在的段 ${e}`, { moduleId: m.id, sectionId: e });
  }

  // 环：顺着 parentId 往上走，走回自己就是环。
  for (const m of modules) {
    const seen = new Set<string>([m.id]);
    let cur = m.parentId ?? null;
    while (cur) {
      if (seen.has(cur)) { add("module_cycle", "error", `模块树成环：${[...seen].join(" → ")} → ${cur}`, { moduleId: m.id }); break; }
      seen.add(cur);
      cur = modules.find((x) => x.id === cur)?.parentId ?? null;
    }
  }

  for (const s of stories)
    for (const mid of s.moduleIds ?? [])
      if (!ids.has(mid))
        add("story_module_unknown", "error", `故事挂在不存在的模块 ${mid} 上`, { storyId: s.id, moduleId: mid });

  /**
   * **这棵树是不是一张清单。**
   *
   * 一层模块太少、或者没有任何模块有子模块，那不是树。机器臂交的正是后者：
   * 7 个模块全是根，`parentId` 全空。
   */
  const roots = modules.filter((m) => !m.parentId);
  const hasChildren = modules.some((m) => !!m.parentId);
  if (modules.length && !hasChildren)
    add("module_tree_is_a_list", "warn", `${modules.length} 个模块没有任何父子关系：这是一张清单，不是一棵树`);
  else if (roots.length < 3 && modules.length >= 6)
    add("module_tree_too_narrow", "info", `只有 ${roots.length} 个一层模块：顶层切得太粗，下游按根模块拆单元时会失衡`);

  /**
   * **材料的每一段都要有落点。**
   *
   * 把「漏了什么」从靠人对着界面数变成可机检。2026-09-11 实测：机器臂整段没认领
   * `observed-zh.md#1`（全站导航）与 `domain-perp-zh.md#13`（预测市场是另一套风控模型），
   * 而后者正是它把预测市场整个漏掉的根。
   */
  if (sections?.length) {
    const claimed = new Set<string>();
    for (const m of modules) for (const e of m.evidence ?? []) claimed.add(e);
    for (const s of stories) for (const e of s.evidence ?? []) claimed.add(e);
    /**
     * **「看不到」不是不在范围内，那是覆盖缺口。**
     *
     * 2026-09-11 第二轮：给了 `outOfScope` 这个出口之后，模型立刻把它用成了洗白机制——
     * 三段领域知识全部以「界面上无直接展示 / 未明确显示 / 未展开」为由宣布不在范围内，
     * 其中一段（高级订单类型）的理由里自己写着「TWAP 和追价在账户面板中有独立标签」。
     *
     * 范围外的意思是**这一段根本不描述这个产品的行为**（定义、写用例的规矩）；
     * 「我没看到」的正确去处是 `acceptance` 里的【待确认】，它是缺口，要有人去补。
     * 这条判不了「该不该在范围内」，只判「这个理由的形状不对」，所以记 info 交给人。
     */
    const VISIBILITY = /看不到|观察不到|未展示|未显示|未展开|无直接展示|尚未观察|没有观察到|界面中未|界面上未/;
    for (const o of outOfScope) {
      if (o.reason && VISIBILITY.test(o.reason))
        add("out_of_scope_is_actually_a_gap", "info",
          "以「界面上看不到」为由宣布不在范围内：那是覆盖缺口，该写成【待确认】让人去补，而不是从范围里划掉",
          { sectionId: o.sectionId });
      if (!o.reason?.trim())
        add("out_of_scope_without_reason", "warn", "声明了不在范围内却没说为什么：那和漏掉一样", { sectionId: o.sectionId });
      else if (!sections.includes(o.sectionId))
        add("out_of_scope_unknown_section", "warn", `声明不在范围内的段 ${o.sectionId} 在材料里不存在`, { sectionId: o.sectionId });
      else claimed.add(o.sectionId);
    }
    for (const sec of sections)
      if (!claimed.has(sec))
        add("material_section_unclaimed", "warn",
          `材料的这一段没有被任何模块或故事引用：它要么该有落点，要么该显式写成不在范围内`,
          { sectionId: sec });
  }

  /**
   * **叶子模块的故事扇出。**
   *
   * 树的价值在于它比故事粗。叶子和故事接近 1:1 时它没有在提供结构。
   * 实测机器臂 0.86、参照臂 1.25，两臂都没过 1.5 —— 这一条同时点到了出题人自己。
   */
  if (stories.length) {
    const leaves = leafModules(modules);
    const perLeaf = new Map(leaves.map((m) => [m.id, 0]));
    for (const s of stories)
      for (const mid of s.moduleIds ?? [])
        if (perLeaf.has(mid)) perLeaf.set(mid, perLeaf.get(mid)! + 1);
    for (const [mid, n] of perLeaf)
      if (n === 0) add("leaf_without_story", "warn", "叶子模块没有任何故事：它要么该有，要么不该是一个模块", { moduleId: mid });
    if (leaves.length) {
      const fanout = [...perLeaf.values()].reduce((a, b) => a + b, 0) / leaves.length;
      if (fanout < minLeafFanout)
        add("leaf_fanout_too_low", "warn",
          `叶子模块平均 ${fanout.toFixed(2)} 条故事（下限 ${minLeafFanout}）：树没有比故事更粗，这是一张故事清单穿了树的外衣`);
    }
  }

  return out;
}

/** 一句人能读的话。 */
export function describeModulePlan(findings: PlanFinding[]): string {
  const by = (s: PlanSeverity) => findings.filter((f) => f.severity === s).length;
  return findings.length
    ? `模块树检查：错 ${by("error")} · 警告 ${by("warn")} · 提示 ${by("info")}`
    : "模块树检查：没有发现问题";
}
