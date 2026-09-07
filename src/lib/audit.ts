/**
 * 审计台的数据层：**机器判不了的那些**，三种来源。
 *
 * 为什么这一层存在——一条实测的漏斗：一次运行**生成 297 条、被人决定 0 条**。
 * 复核队列把人放在「评分员」的位置上，要求他对全部产出逐条打分；而一天上百条评分，
 * 没有人会干第二天。三路调研里人的位置从来不是评分员：
 *
 *   ① OpenAI 那条线——人标**样本**（30 条分层抽样）用来校准 judge，不标全量；
 *   ② Inspect 那条线——人看 Scanner 的**审计报告**，即「机器自己觉得可疑的那些」；
 *   ③ Cursor 那条线——人只处理**被标出来的**，其余默认放行。
 *
 * 所以队列里装的东西从「全部」换成三份筛过的集合，这个文件就是那三份集合的入口。
 * 决定 UI 形状的是数据形状，所以类型**照抄 `docs/v3/01-数据契约.md`**（§1 Decision、
 * §2 HumanLabel、§3 ScanFinding/ScanReport），一个字段都不改名——审计台与
 * `score_run` / `calibrate_judge` 读的必须是同一份东西，前端另立一份名字，
 * 到 Phase 1C 对接时就要在两套名字之间翻译，而翻译层是所有字段丢失的来源。
 *
 * 三个端点 **Phase 1C 才会建**。在那之前（以及真端点 404 时）这里退回内置假数据，
 * 界面因此可以在没有后端的情况下走完整条动线——这也是唯一能在 Phase 2 就验出
 * 「三个 tab 共用同一套键盘动线」是否成立的办法。
 */
import { API_BASE } from "@/lib/base";

/* ── 契约类型（照抄 docs/v3/01-数据契约.md，不改名不增删） ───────────────── */

/** §1 `Decision` —— 审计台写回 `runs/<runId>/decisions.json`，下一 session 的 `read_decisions` 读它。 */
export interface Decision {
  caseId: string;
  decision: "approved" | "rejected" | "revised";
  by: string;
  /** 只有一个值。批准永远是人——类型上没有 agent。 */
  decidedByKind?: "human";
  at: string;
  edit?: { title?: string; steps?: string[]; expected?: string };
  reason?: string;
}

/**
 * §2 `HumanLabel` —— 第 0 步那 30 条。judge 校准（κ）与 gate 阈值的锚。
 *
 * `heldOut` 的一半**从不进任何调优**（P2：考卷不能由考生出）。界面上必须标出来，
 * 否则人会以为自己在标一批等价的东西，而其中一半的用途完全不同。
 */
export interface HumanLabel {
  goldId: string;
  caseId: string;
  runId: string;
  /** 这条用例是否覆盖了这条清单项。 */
  covered: boolean;
  by: string;
  at: string;
  heldOut: boolean;
}

/** §3 `ScanFinding.kind` 的五种。英文枚举，界面按它取词条，不显示原值。 */
export const SCAN_KINDS = [
  "assert-trivial",
  "unanchored",
  "touched-sut",
  "duplicate",
  "unfounded-step",
] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

/** §3 `ScanFinding` —— 审计台「审计报告」tab 的每一行。 */
export interface ScanFinding {
  caseId: string;
  kind: ScanKind;
  /** 一句可核对的话 + 指向哪里。它是这一行存在的理由，不能省。 */
  evidence: string;
  severity: "block" | "warn";
}

/** §3 `ScanReport` —— Scanner 的产物独立于 runs/，可跨运行汇总。 */
export interface ScanReport {
  runId: string;
  at: string;
  /** scanner skill 的版本（`YYYY-MM-DD.N`）。 */
  scanner: string;
  findings: ScanFinding[];
}

/* ── 三个端点的请求 / 响应形状（Phase 1C 建，契约在此） ─────────────────── */

/** 分层抽样里的一条：一条用例 × 一条清单项，人回答「覆盖了没有」。 */
export interface CalibrationItem {
  caseId: string;
  goldId: string;
  /** 清单项的原话——人判断的对象是它，不是用例标题。 */
  goldTitle: string;
  heldOut: boolean;
}

/** `GET /api/audit/:runId/calibration` */
export interface CalibrationPayload {
  /** 30 条，按故事/页面分层，一半 `heldOut`。 */
  sample: CalibrationItem[];
  /** 已经标过的。界面据此显示进度与每条的当前答案。 */
  labels: HumanLabel[];
  /** 标够之后 `calibrate_judge` 算出来的一致性。没标够就没有。 */
  kappa?: number;
}

/** `GET /api/audit/:runId/diff` —— 相对**上次批准集**的差。 */
export interface DiffPayload {
  added: string[];
  removed: Array<{ caseId: string; title: string }>;
  changed: Array<{
    caseId: string;
    before: { expected: string };
    after: { expected: string };
  }>;
}

/** 三个 tab 的 id。也是 `?tab=` 里的值——深链要能指到具体一个镜头。 */
export type AuditTab = "calibrate" | "scan" | "diff";
export const AUDIT_TABS: AuditTab[] = ["calibrate", "scan", "diff"];
export const isAuditTab = (x: string | null | undefined): x is AuditTab =>
  !!x && (AUDIT_TABS as string[]).includes(x);

/**
 * 取回来的东西，**外加它是不是假的**。
 *
 * `mock` 不是调试开关的副产品，它要印在界面上。一个读着真实数字的人，
 * 有权知道这些数字是不是编的——把假数据画得和真数据一模一样，
 * 是这一类界面最容易犯、也最难在事后发现的错。
 */
export interface Fetched<T> {
  data: T;
  mock: boolean;
}

/* ── mock ─────────────────────────────────────────────────────────────── */

/** 打开假数据：`localStorage.setItem("tp:audit-mock", "1")`。 */
export const AUDIT_MOCK_KEY = "tp:audit-mock";

export const auditMockOn = (): boolean => {
  try {
    return localStorage.getItem(AUDIT_MOCK_KEY) === "1";
  } catch {
    /* 隐私模式下 localStorage 会抛——那就是"没开"。 */
    return false;
  }
};

/**
 * 假数据要**覆盖每一种会改变界面的取值**，否则它只能验出"页面没崩"。
 *
 * 所以：校准 8 条里 4 条 `heldOut`、3 条已标（两 covered 一 not）；
 * 审计 7 条覆盖五种 `kind`，其中 2 条 `block`；
 * 变化三类都有（新增 / 消失 / 断言变了）。
 */
const mockCalibration = (runId: string): CalibrationPayload => {
  const sample: CalibrationItem[] = [
    { caseId: "c-0a41", goldId: "g-01", goldTitle: "按姓氏检索主人，能命中同姓的多条", heldOut: false },
    { caseId: "c-1b72", goldId: "g-02", goldTitle: "姓氏留空时列出全部主人", heldOut: false },
    { caseId: "c-2c03", goldId: "g-03", goldTitle: "新增主人后回到详情页并显示刚填的电话", heldOut: true },
    { caseId: "c-3d94", goldId: "g-04", goldTitle: "电话为空时不允许提交，并指出是哪一栏", heldOut: true },
    { caseId: "c-4e15", goldId: "g-05", goldTitle: "编辑主人不会新建出第二条记录", heldOut: false },
    { caseId: "c-5f26", goldId: "g-06", goldTitle: "给主人添加宠物后，主人详情里多一行", heldOut: true },
    { caseId: "c-6a37", goldId: "g-07", goldTitle: "宠物生日填未来日期时被拒绝", heldOut: false },
    { caseId: "c-7b48", goldId: "g-08", goldTitle: "兽医列表按专长分组显示", heldOut: true },
  ];
  const at = new Date().toISOString();
  const labels: HumanLabel[] = [
    { goldId: "g-01", caseId: "c-0a41", runId, covered: true, by: "mock", at, heldOut: false },
    { goldId: "g-02", caseId: "c-1b72", runId, covered: true, by: "mock", at, heldOut: false },
    { goldId: "g-03", caseId: "c-2c03", runId, covered: false, by: "mock", at, heldOut: true },
  ];
  return { sample, labels, kappa: 0.62 };
};

const mockScan = (runId: string): ScanReport => ({
  runId,
  at: new Date().toISOString(),
  scanner: "2026-09-02.1",
  findings: [
    {
      caseId: "c-0a41",
      kind: "assert-trivial",
      severity: "block",
      evidence: "期望只写了「页面正常显示」——任何没崩的页面都能过（expected）",
    },
    {
      caseId: "c-1b72",
      kind: "unanchored",
      severity: "block",
      evidence: "断言里的「共 12 位主人」在这次探索的 DOM 观察里查不到（expected）",
    },
    {
      caseId: "c-2c03",
      kind: "touched-sut",
      severity: "warn",
      evidence: "步骤 4「删除刚才创建的主人」会改被测对象，且没有 postSteps 放回去（steps）",
    },
    {
      caseId: "c-3d94",
      kind: "duplicate",
      severity: "warn",
      evidence: "与已批准的 c-91f0 三元组相同（story/method/expected 全等）",
    },
    {
      caseId: "c-4e15",
      kind: "unfounded-step",
      severity: "warn",
      evidence: "步骤 2 引用的「批量导入」按钮在 /owners 的控件清单里不存在（steps）",
    },
    {
      caseId: "c-5f26",
      kind: "unanchored",
      severity: "warn",
      evidence: "断言里的提示语「保存成功」只在规格里出现过，运行时观察里没有（expected）",
    },
    {
      caseId: "c-6a37",
      kind: "assert-trivial",
      severity: "warn",
      evidence: "期望是「URL 包含 /owners」——这条用例任何一步失败它也成立（expected）",
    },
  ],
});

const mockDiff = (): DiffPayload => ({
  added: ["c-8c59", "c-9d6a"],
  removed: [
    { caseId: "c-91f0", title: "按姓氏检索主人（空结果提示）" },
    { caseId: "c-a2e1", title: "兽医列表分页到第二页" },
  ],
  changed: [
    {
      caseId: "c-0a41",
      before: { expected: "列表里出现 Davis，且只出现一次" },
      after: { expected: "页面正常显示" },
    },
    {
      caseId: "c-4e15",
      before: { expected: "主人总数不变，电话更新为新值" },
      after: { expected: "主人总数不变" },
    },
  ],
});

/* ── 取数 ─────────────────────────────────────────────────────────────── */

/**
 * 一次 GET，**404 退回假数据而不是报错**。
 *
 * 理由是这三个端点 Phase 1C 才建：在那之前一个红色的 `HTTP 404` 会把整屏变成
 * 一句技术错误，而人根本无从判断是"还没建"还是"坏了"。退回假数据并把这件事
 * 在页头说明白（`EmptyState`），两者才分得开。
 *
 * 只吞 404 与网络错误。**5xx 照样抛**——那是"建了但坏了"，必须看得见。
 */
async function get<T>(path: string, fallback: () => T): Promise<Fetched<T>> {
  if (auditMockOn()) return { data: fallback(), mock: true };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`);
  } catch {
    return { data: fallback(), mock: true };
  }
  if (res.status === 404) return { data: fallback(), mock: true };
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${path}`);
  return { data: (await res.json()) as T, mock: false };
}

/** `GET /api/audit/:runId/calibration` → `{ sample, labels, kappa? }` */
export const fetchCalibration = (runId: string): Promise<Fetched<CalibrationPayload>> =>
  get(`/api/audit/${encodeURIComponent(runId)}/calibration`, () => mockCalibration(runId));

/** `GET /api/audit/:runId/scan` → `ScanReport` */
export const fetchScan = (runId: string): Promise<Fetched<ScanReport>> =>
  get(`/api/audit/${encodeURIComponent(runId)}/scan`, () => mockScan(runId));

/** `GET /api/audit/:runId/diff` → `{ added, removed, changed }` */
export const fetchDiff = (runId: string): Promise<Fetched<DiffPayload>> =>
  get(`/api/audit/${encodeURIComponent(runId)}/diff`, () => mockDiff());

/**
 * `POST /api/audit/:runId/labels`，body 是 `HumanLabel[]`。
 *
 * **整批提交而不是每标一条发一次**：这 30 条是一份样本，它的意义在于整份——
 * 半份标注既算不出 κ，也不该进 `benchmark/<capability>/human-labels.json`。
 * 但界面上每标一条就发一次也没错（后端按 `goldId+caseId` 覆盖），
 * 所以这里接受任意长度的数组，由调用处决定攒多少。
 *
 * mock 模式下不发请求：假数据没有归宿，静默成功比假装写进去了更诚实。
 */
export async function postLabels(runId: string, labels: HumanLabel[]): Promise<{ mock: boolean }> {
  if (auditMockOn()) return { mock: true };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/audit/${encodeURIComponent(runId)}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(labels),
    });
  } catch {
    return { mock: true };
  }
  if (res.status === 404) return { mock: true };
  if (!res.ok) throw new Error(`HTTP ${res.status} · labels`);
  return { mock: false };
}
