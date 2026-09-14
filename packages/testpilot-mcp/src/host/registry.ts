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

export const DOMAINS: readonly DomainSpec[] = [project, run, stage, unit, artifact, review, execution];

/** `<domain>.<action>` → 规格。`check-host-parity` 与工具注册都从这里取。 */
export function actionIndex(): Map<string, { domain: DomainSpec; action: string; spec: ActionSpec }> {
  const out = new Map<string, { domain: DomainSpec; action: string; spec: ActionSpec }>();
  for (const domain of DOMAINS)
    for (const [action, spec] of Object.entries(domain.actions))
      out.set(`${domain.tool}.${action}`, { domain, action, spec });
  return out;
}
