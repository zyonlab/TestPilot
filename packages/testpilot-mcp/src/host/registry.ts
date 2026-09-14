import { z } from "zod";

/**
 * 宿主能做的每一件事，在这里各占一行。
 *
 * **一行 = 一个 UI 操作。** `server/host-parity.json` 的 `host:` 字段指的就是这里的
 * `<domain>.<action>`，而 `scripts/check-host-parity.mjs` 保证每条 UI 路由要么在这里
 * 有对应的一行，要么被显式标成「还没做」或「故意不给」。
 *
 * 声明式而不是一个个手写工具，理由是漂移：163 条路由手写一遍，必然有几条和 UI 说的不是
 * 同一件事，而且没人看得出来。这张表让「宿主少了什么」变成一个可以数的数。
 */
export interface ActionSpec {
  /** 一句话说清它做什么——这句会进 MCP 工具描述，agent 靠它选动作。 */
  summary: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 路径模板，`:name` 由 `params` 填。 */
  path: string;
  /** 路径参数名，按出现顺序。缺一个就当场报错，不发请求。 */
  params?: readonly string[];
  /** 这个动作要不要运行写入凭证（`stages/*` 这类）。 */
  needsRunGrant?: boolean;
  /** 请求体的形状。不给就是没有请求体。 */
  body?: z.ZodTypeAny;
  /**
   * 会改变外部世界的动作要标出来。这不是权限控制（权限在服务端），
   * 是为了让 agent 与人一眼看出「这一步会动真东西」。
   */
  mutates?: boolean;
}

export interface DomainSpec {
  /** MCP 工具名，形如 `tp_project`。 */
  tool: string;
  title: string;
  description: string;
  actions: Record<string, ActionSpec>;
}

const json = z.record(z.unknown());

/** 项目：建项目、看项目、挂规则包与领域知识，以及环境与密钥（只给名字）。 */
const project: DomainSpec = {
  tool: "tp_project",
  title: "项目与领域知识",
  description:
    "建项目、列项目，以及挂在项目上的规则包、数据集、环境与密钥元信息。" +
    "参数不全时不要猜——把缺的字段问人，人答完再调一次。",
  actions: {
    list: { summary: "列出全部项目（不知道 projectId 时先用它）", method: "GET", path: "/api/projects" },
    overview: { summary: "读一个项目的总览：用例数、最近运行、健康度", method: "GET", path: "/api/projects/:id/overview", params: ["id"] },
    create: {
      summary: "新建项目。name 与 targetUrl 必填，缺了就问人，不要编一个地址",
      method: "POST", path: "/api/projects", mutates: true,
      body: z.object({ name: z.string().min(1), targetUrl: z.string().url(), targetPlatform: z.string().optional() }),
    },
    update: { summary: "改项目（名字、目标地址）", method: "PATCH", path: "/api/projects/:id", params: ["id"], mutates: true, body: json },
    remove: { summary: "删项目。不可撤销，动手前先跟人确认", method: "DELETE", path: "/api/projects/:id", params: ["id"], mutates: true },
    materials: { summary: "列出可用的材料（领域知识正文）", method: "GET", path: "/api/materials" },
    rule_packs: { summary: "列出项目绑定的规则包", method: "GET", path: "/api/projects/:id/rule-packs", params: ["id"] },
    rule_pack: { summary: "读一份规则包的全文", method: "GET", path: "/api/projects/:id/rule-packs/:hash", params: ["id", "hash"] },
    add_rule_pack: {
      summary: "给项目加一份规则包（领域不变量的正本；故事与用例节点靠它拿到领域约束）",
      method: "POST", path: "/api/projects/:id/rule-packs", params: ["id"], mutates: true, body: json,
    },
    remove_rule_pack: { summary: "解绑一份规则包", method: "DELETE", path: "/api/projects/:id/rule-packs/:hash", params: ["id", "hash"], mutates: true },
    environments: { summary: "列出项目的环境（基址、变量、视口）", method: "GET", path: "/api/projects/:id/environments", params: ["id"] },
    add_environment: { summary: "给项目加一个环境", method: "POST", path: "/api/projects/:id/environments", params: ["id"], mutates: true, body: json },
    secrets: { summary: "列出密钥的**名字**（值永远不返回，也不该问）", method: "GET", path: "/api/projects/:id/secrets", params: ["id"] },
    datasets: { summary: "列出项目的测试数据集", method: "GET", path: "/api/projects/:id/datasets", params: ["id"] },
  },
};


/** 运行：起跑、找回、进度、断点、预算、取消与恢复。 */
const run: DomainSpec = {
  tool: "tp_run",
  title: "工作流运行",
  description:
    "起一次运行、列出这个项目跑过哪些、读进度与检查点。" +
    "**新会话里先 list 找回 runId**——它只在服务器上，宿主上一次会话结束就忘了。",
  actions: {
    list: { summary: "列出这个项目的全部运行（新会话先用它找回 runId）", method: "GET", path: "/api/projects/:projectId/workflow-runs", params: ["projectId"] },
    get: { summary: "读一次运行：绑定、节点状态、产物修订清单", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId", params: ["projectId", "runId"] },
    checkpoint: { summary: "读检查点：下一个该跑的节点、各节点跑到哪了", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/checkpoint", params: ["projectId", "runId"] },
    start: {
      summary: "起一次新运行。sourceKind=explore 时服务端会开浏览器探索（宿主没有浏览器，探索必须在服务端）",
      method: "POST", path: "/api/projects/:projectId/workflow-runs", params: ["projectId"], mutates: true, body: json,
    },
    register: { summary: "注册一次宿主规划的运行（材料由宿主给，冻结在注册那一刻）", method: "POST", path: "/api/projects/:projectId/workflow-runs/register", params: ["projectId"], mutates: true, body: json },
    resume: { summary: "恢复一次停住的运行，从检查点的下一个节点接着跑", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/resume", params: ["projectId", "runId"], mutates: true },
    cancel: { summary: "取消一次运行", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/cancel", params: ["projectId", "runId"], mutates: true },
    spend: { summary: "读这次运行各角色花了多少模型调用", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/spend", params: ["projectId", "runId"] },
    events: { summary: "追加一条运行事件（宿主侧的进度回报）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/events", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    breakpoints: { summary: "设断点：让运行在某个节点前停下等人", method: "PATCH", path: "/api/wf/runs/:id/breakpoints", params: ["id"], mutates: true, body: json },
    budget: { summary: "改这次运行的预算", method: "PATCH", path: "/api/wf/runs/:id/budget", params: ["id"], mutates: true, body: json },
    node: { summary: "读一个节点的产物", method: "GET", path: "/api/wf/runs/:id/nodes/:nodeId", params: ["id", "nodeId"] },
    run_node: { summary: "单独重跑一个节点", method: "POST", path: "/api/wf/runs/:id/nodes/:nodeId/run", params: ["id", "nodeId"], mutates: true, body: json },
    resume_point: { summary: "读可恢复点", method: "GET", path: "/api/wf/runs/:id/resume-point", params: ["id"] },
    traceability: { summary: "读这次运行的追溯线：材料 → 故事 → 用例 → 执行", method: "GET", path: "/api/wf/runs/:id/traceability", params: ["id"] },
  },
};

/** 节点：九步流水线的每一步，以及冻结与复核这两处人工闸。 */
const stage: DomainSpec = {
  tool: "tp_stage",
  title: "流水线节点",
  description:
    "按顺序跑流水线的每个节点。每步之前先 begin，返回 paused/cancelled/failed 就停下别硬闯。" +
    "冻结模块树与复核用例是**人做的决定**——把内容摆给人看，人点头了再调。",
  actions: {
    begin: { summary: "开始一个节点（node: source|modules|instructions|stories|cases|gate|finalize|g2|execution）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/begin-stage", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    instructions: { summary: "载入这次运行冻结版本的 skill 与领域参考", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/instructions", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    retrieve: { summary: "检索材料段落，返回的 chunk id 才能写进 sourceRefs", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/retrieve", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    modules: { summary: "提议模块树", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/modules", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    modules_state: { summary: "读模块树状态：提了没、冻没冻、机检说了什么", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/modules/state", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    freeze_modules: { summary: "冻结模块树。**这是人的决定**——把树摆给人看，人点头了再调", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/modules/freeze", params: ["projectId", "runId"], mutates: true, body: json },
    stories: { summary: "整份写用户故事（开了工作单元的运行会被拒，改用 tp_unit）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/stories", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    cases: { summary: "整份写文本用例（同上）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/cases", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    gate: { summary: "跑设计门禁，返回可操作的 findings", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/gate", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    finalize: { summary: "定稿，交给人复核", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/finalize", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    g2: { summary: "把人已批准的用例编译成可执行代码", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/g2", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    execute: { summary: "执行已编译的代码（服务端开浏览器跑，可传 caseIds 只跑一部分）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/execute", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    decisions: { summary: "读复核决定", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/decisions", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    status: { summary: "读节点产物的注册与定稿状态", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/status", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
  },
};

/** 工作单元：服务端拆、规划器一次只领一个。 */
const unit: DomainSpec = {
  tool: "tp_unit",
  title: "工作单元循环",
  description:
    "开了 workUnits 的运行不整份写：服务端把活拆成单元，一次领一个、写一个，全写完服务端合并。" +
    "领到什么写什么——契约、材料、这个单元该写几条，都在 claim 的返回里。",
  actions: {
    claim: { summary: "领一个单元，返回它的范围、材料与契约", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/units/claim", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    write: { summary: "写一个单元的产物（只校验这个单元，错在哪个单元就修哪个）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/units/write", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    status: { summary: "读全部单元的状态：哪些完了、哪些失败、还剩几个", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/units/status", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
    merge: { summary: "合并全部单元（可单独重试——整份校验会在这里失败）", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/stages/units/merge", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
  },
};

/** 产物：中间产物、物料、血缘、导出。 */
const artifact: DomainSpec = {
  tool: "tp_artifact",
  title: "产物与中间产物",
  description: "列出并读取一次运行留下的每一份东西：材料、模块树、故事、用例、门禁报告、编译产物、执行结果。",
  actions: {
    list: { summary: "列出这个项目的全部产物修订", method: "GET", path: "/api/projects/:projectId/workflow-runs/artifacts", params: ["projectId"] },
    read: { summary: "读一份产物的正文", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/artifacts/:revisionId", params: ["projectId", "runId", "revisionId"] },
    lineage: { summary: "读一份产物的血缘：它从哪几份产物来", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/artifacts/:revisionId/lineage", params: ["projectId", "runId", "revisionId"] },
    diff: { summary: "和上一版比差在哪", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/artifacts/:revisionId/diff", params: ["projectId", "runId", "revisionId"] },
    export: { summary: "导出一份产物", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/artifacts/:revisionId/export", params: ["projectId", "runId", "revisionId"] },
    import: { summary: "导入一份外部产物", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/artifacts", params: ["projectId", "runId"], mutates: true, body: json, needsRunGrant: true },
  },
};

/** 复核：把用例摆给人看，人点头了再写决定。 */
const review: DomainSpec = {
  tool: "tp_review",
  title: "人工复核",
  description:
    "读待复核的用例、写复核决定。**批准与驳回是人的决定**——把用例摆给人看，" +
    "人说了才写，而且要在 note 里写清楚这是谁的判断。agent 不该批准自己写的用例。",
  actions: {
    list: { summary: "读这次运行待复核的用例与它们的修订", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/review", params: ["projectId", "runId"] },
    history: { summary: "读复核历史", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/review-history", params: ["projectId", "runId"] },
    decide: { summary: "写复核决定（approved / rejected）。人点头了再调", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/review", params: ["projectId", "runId"], mutates: true, body: json },
    amend: { summary: "修订一条已有的复核决定", method: "PATCH", path: "/api/projects/:projectId/workflow-runs/:runId/review", params: ["projectId", "runId"], mutates: true, body: json },
  },
};

/** 执行与基线：跑完之后的那些数。 */
const execution: DomainSpec = {
  tool: "tp_execution",
  title: "执行结果与基线",
  description: "读执行批次的结果、和基线比、立新基线。",
  actions: {
    list: { summary: "列出这次运行的执行批次", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/executions", params: ["projectId", "runId"] },
    baseline: { summary: "读当前的判决集基线", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/executions/baseline", params: ["projectId", "runId"] },
    set_baseline: { summary: "把某次执行立为基线。**这是人的决定**", method: "POST", path: "/api/projects/:projectId/workflow-runs/:runId/executions/baseline", params: ["projectId", "runId"], mutates: true, body: json },
    compare: { summary: "把一次执行和基线比：哪几条翻了", method: "GET", path: "/api/projects/:projectId/workflow-runs/:runId/executions/compare", params: ["projectId", "runId"] },
  },
};


/** 用例：看板上的那一份。改、跑、生成代码、隔离、基线。 */
const kase: DomainSpec = {
  tool: "tp_case",
  title: "用例",
  description:
    "看板上的用例：读、改、单条跑、生成代码、隔离不稳定的、立视觉与性能基线。" +
    "「跑一条」由服务端开浏览器执行——宿主没有浏览器。",
  actions: {
    list: { summary: "列出用例（可按项目筛）", method: "GET", path: "/api/cases" },
    create: { summary: "新建一条用例", method: "POST", path: "/api/cases", mutates: true, body: json },
    update: { summary: "改一条用例", method: "PATCH", path: "/api/cases/:id", params: ["id"], mutates: true, body: json },
    remove: { summary: "删一条用例", method: "DELETE", path: "/api/cases/:id", params: ["id"], mutates: true },
    code: { summary: "读一条用例编译出来的代码", method: "GET", path: "/api/cases/:id/code", params: ["id"] },
    set_code: { summary: "改一条用例的代码", method: "PATCH", path: "/api/cases/:id/code", params: ["id"], mutates: true, body: json },
    generate_code: { summary: "为一条用例生成代码", method: "POST", path: "/api/cases/:id/generate-code", params: ["id"], mutates: true, body: json },
    run: { summary: "跑一条用例（服务端开浏览器；执行层带缓存，同一条重跑省 token）", method: "POST", path: "/api/cases/:id/run", params: ["id"], mutates: true, body: json },
    debug: { summary: "读一条用例的调试信息：每一步看到了什么、判据怎么判的", method: "GET", path: "/api/cases/:id/debug", params: ["id"] },
    refine: { summary: "让模型改写一条用例（自愈不许动 oracle）", method: "POST", path: "/api/cases/:id/refine", params: ["id"], mutates: true, body: json },
    quarantine: { summary: "把不稳定的用例隔离：照跑但不进门禁", method: "POST", path: "/api/cases/:id/quarantine", params: ["id"], mutates: true, body: json },
    recompute_flakiness: { summary: "重算这条用例的不稳定度", method: "POST", path: "/api/cases/:id/recompute-flakiness", params: ["id"], mutates: true, body: json },
    approve_visual_baseline: { summary: "批准视觉基线。**这是人的决定**", method: "POST", path: "/api/cases/:id/baselines/approve", params: ["id"], mutates: true, body: json },
    approve_perf_baseline: { summary: "批准性能基线。**这是人的决定**", method: "POST", path: "/api/cases/:id/perf-baseline/approve", params: ["id"], mutates: true, body: json },
    baseline_verdict: { summary: "对判决集基线表态", method: "POST", path: "/api/cases/:id/baseline-verdict", params: ["id"], mutates: true, body: json },
    // 绑定没有独立的写入路由：改绑定走 `update`（PATCH /api/cases/:id）的 dataKey 字段。
    data_binding: { summary: "读用例绑定的数据集与列", method: "GET", path: "/api/cases/:id/data-binding", params: ["id"] },
  },
};

/** 报告：跑完之后的那些数——单次运行、批次、趋势、成本、不稳定度。 */
const report: DomainSpec = {
  tool: "tp_report",
  title: "运行报告与趋势",
  description: "读执行结果：单次运行的报告、批次、待批基线、趋势、成本、不稳定度、追溯线。",
  actions: {
    runs: { summary: "列出最近的执行", method: "GET", path: "/api/runs" },
    run: { summary: "读一次执行", method: "GET", path: "/api/runs/:id", params: ["id"] },
    report: { summary: "读一次执行的完整报告：每一步、截图、判据、失败归因", method: "GET", path: "/api/runs/:id/report", params: ["id"] },
    batches: { summary: "列出项目的批次", method: "GET", path: "/api/projects/:id/batches", params: ["id"] },
    batch: { summary: "读一个批次", method: "GET", path: "/api/batches/:id", params: ["id"] },
    cancel_batch: { summary: "取消一个批次", method: "POST", path: "/api/batches/:id/cancel", params: ["id"], mutates: true },
    pending_baselines: { summary: "列出等人批的基线", method: "GET", path: "/api/projects/:id/pending-baselines", params: ["id"] },
    trends: { summary: "读项目趋势：通过率、覆盖、成本随时间怎么走", method: "GET", path: "/api/projects/:id/trends", params: ["id"] },
    cost: { summary: "读项目花了多少", method: "GET", path: "/api/projects/:id/cost", params: ["id"] },
    flakiness: { summary: "读项目的不稳定度", method: "GET", path: "/api/projects/:id/flakiness", params: ["id"] },
    traceability: { summary: "读项目的追溯线：需求 → 用例 → 执行", method: "GET", path: "/api/projects/:id/traceability", params: ["id"] },
    quarantine_log: { summary: "读隔离记录", method: "GET", path: "/api/projects/:id/quarantine-log", params: ["id"] },
    changes: { summary: "读项目的变更记录", method: "GET", path: "/api/projects/:id/changes", params: ["id"] },
    code_line: { summary: "读代码线：哪条用例的代码来自哪次运行", method: "GET", path: "/api/projects/:id/code-line", params: ["id"] },
    queue: { summary: "读执行队列：现在有什么在排队跑", method: "GET", path: "/api/queue" },
    readiness: { summary: "读就绪度：这个项目现在能不能交付一套能跑的测试", method: "GET", path: "/api/readiness" },
    defects: { summary: "读缺陷清单：执行找出来的产品问题", method: "GET", path: "/api/defects" },
  },
};

/** 导出：把批准的用例变成一个能自己跑的 Playwright 工程。 */
const exportProject: DomainSpec = {
  tool: "tp_export",
  title: "生成用例代码工程",
  description:
    "把项目里批准的用例导成一个能离开平台自己跑的 Playwright + Midscene 工程。" +
    "工程里分两种文件：生成物（每次覆盖）与脚手架（只在缺失时创建），见导出 README。",
  actions: {
    preflight: { summary: "导出前检查：哪些用例没代码、哪些被隔离、登录带没带走", method: "GET", path: "/api/projects/:id/export-preflight", params: ["id"] },
    export: { summary: "导出工程（format=json 拿文件表，否则是 zip）", method: "GET", path: "/api/projects/:id/export", params: ["id"] },
    suite: { summary: "跑整套：批量执行项目里的用例", method: "POST", path: "/api/projects/:id/suite", params: ["id"], mutates: true, body: json },
  },
};

/** 设置：模型、环境会话、全局配置。 */
const settings: DomainSpec = {
  tool: "tp_settings",
  title: "设置",
  description: "模型配置与探针、每个角色的模型档案、环境会话、全局设置。密钥的值永远不经过这里。",
  actions: {
    get: { summary: "读全局设置", method: "GET", path: "/api/settings" },
    set: { summary: "改全局设置", method: "POST", path: "/api/settings", mutates: true, body: json },
    reset_prompts: { summary: "把提示词恢复成出厂", method: "POST", path: "/api/settings/reset-prompts", mutates: true, body: json },
    model_config: { summary: "读模型配置", method: "GET", path: "/api/model/config" },
    set_model_config: { summary: "改模型配置", method: "POST", path: "/api/model/config", mutates: true, body: json },
    test_model: { summary: "探一次模型端点：活着吗、能不能看图", method: "POST", path: "/api/model/test", mutates: true, body: json },
    profiles: { summary: "读各角色的模型档案", method: "GET", path: "/api/projects/:projectId/model-profiles", params: ["projectId"] },
    set_profile: { summary: "设某个角色的模型档案", method: "PUT", path: "/api/projects/:projectId/model-profiles/:role", params: ["projectId", "role"], mutates: true, body: json },
    probe_profile: { summary: "探一个角色的模型档案", method: "POST", path: "/api/projects/:projectId/model-profiles/:role/probe", params: ["projectId", "role"], mutates: true, body: json },
    capture_session: { summary: "抓一次登录会话存进环境", method: "POST", path: "/api/environments/:id/capture-session", params: ["id"], mutates: true, body: json },
    set_session: { summary: "直接写入一份会话", method: "POST", path: "/api/environments/:id/set-session", params: ["id"], mutates: true, body: json },
    clear_session: { summary: "清掉环境里的会话", method: "DELETE", path: "/api/environments/:id/session", params: ["id"], mutates: true },
    api_login: { summary: "配置接口登录", method: "POST", path: "/api/environments/:id/api-login", params: ["id"], mutates: true, body: json },
    remove_environment: { summary: "删一个环境", method: "DELETE", path: "/api/environments/:id", params: ["id"], mutates: true },
    capabilities: { summary: "读可用的外部能力（本地链、基准站点等）", method: "GET", path: "/api/capabilities" },
  },
};

/** 评测：记分板、gold、配对评测、变异检测。 */
const evaluation: DomainSpec = {
  tool: "tp_eval",
  title: "评测与记分板",
  description: "读记分板与 gold、跑配对评测与变异检测。gold 与人工标注是冻结的，只读不改。",
  actions: {
    scoreboard: { summary: "读记分板：各能力的当前得分与翻转次数", method: "GET", path: "/api/scoreboard" },
    paired_scoreboard: { summary: "读配对评测的记分板", method: "POST", path: "/api/scoreboard/paired", mutates: true, body: json },
    gold: { summary: "读某个能力的 gold（冻结，只读）", method: "GET", path: "/api/gold/:capability", params: ["capability"] },
    set_gold: { summary: "写 gold。**冻结集，动它要非常确定**", method: "POST", path: "/api/gold/:capability", params: ["capability"], mutates: true, body: json },
    evals: { summary: "列出评测定义（两臂只差一件事的那些对照）", method: "GET", path: "/api/evals" },
    eval: { summary: "读一个评测", method: "GET", path: "/api/evals/:id", params: ["id"] },
    score: { summary: "给一次运行打分", method: "POST", path: "/api/evals/score", mutates: true, body: json },
    paired: { summary: "跑一次配对评测（两臂只差一件事）", method: "POST", path: "/api/evals/paired", mutates: true, body: json },
    detection: { summary: "跑变异检测：人造缺陷，看用例叫不叫", method: "POST", path: "/api/evals/detection", mutates: true, body: json },
  },
};

export const DOMAINS: readonly DomainSpec[] = [project, run, stage, unit, artifact, review, execution, kase, report, exportProject, settings, evaluation];

/** `<domain>.<action>` → 规格。`check-host-parity` 与工具注册都从这里取。 */
export function actionIndex(): Map<string, { domain: DomainSpec; action: string; spec: ActionSpec }> {
  const out = new Map<string, { domain: DomainSpec; action: string; spec: ActionSpec }>();
  for (const domain of DOMAINS)
    for (const [action, spec] of Object.entries(domain.actions))
      out.set(`${domain.tool}.${action}`, { domain, action, spec });
  return out;
}
