import { useEffect, useState } from "react";
import { safeGet, safeSet } from "@/lib/local";
import { MigratedToPenguin } from "@/components/MigratedToPenguin";
import { AppNav } from "@/components/AppNav";
import { CommandPalette } from "@/components/CommandPalette";
import { Shortcuts } from "@/components/Shortcuts";
import { surfaceById, surfacesInGroup } from "@/lib/surfaces";
import { SurfaceTabsProvider } from "@/lib/surfaceTabs";
import { navIdFor, navItemFor } from "@/lib/nav";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";

/**
 * 一个界面。
 *
 * 之前是五个落点、十九个分节——那解决了「东西放哪」，没解决「东西太多」。目录要求人先记住
 * 每样东西归在哪一类才找得到它，而这是一个垂类 agent 产品：应该只有一处干活的地方，
 * 其余的东西**通过你正在处理的那个对象**进入。
 *
 * 所以这里没有路由表，只有工作台：画布占满，产物卡从产出它的那一步打开，
 * 设置退到一个抽屉里。
 *
 * **左侧那条常驻对话栏已经不在了。**它曾经在这里，被删掉的理由见
 * `components/DiagnoseDrawer.tsx` 的文件注释——一条永远在场的对话栏，是在宣告
 * 这个产品主要靠聊天驱动，而它不是。现在提问按对象打开：选中一个节点或一次运行，
 * 再从那里问。
 *
 * 旧地址仍然可用，但它们不再是地址，而是「打开哪张卡」：`#/cases` 会变成 `#/?open=cases`。
 * 拆掉导航不该顺手作废别人存下的链接。
 */
const LEGACY: Record<string, string> = {
  "/cases": "cases",
  "/review": "review",
  "/trace": "trace",
  "/code": "code",
  "/changes": "changes",
  "/deliver": "deliver",
  "/runs": "runs",
  "/suite": "batches",
  "/batches": "batches",
  "/baselines": "baselines",
  "/trends": "trends",
  "/evals": "evals",
  "/assets": "cases",
  "/history": "runs",
};

/** Old section addresses carried their section in `?s=`; that name is now the card's name. */
function normalise(): void {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query ?? "");
  if (params.get("open")) return;

  /**
   * `#/review/<runId>` 是给人发链接用的短写法。
   *
   * 这个应用只有一个地址，别的路径一律被规整回 `#/`——包括这一个，
   * 于是「请复核这一次」这句话没有对应的链接可发。规整成
   * `#/?open=review&run=<id>`，短写法照样能用，内部仍然只有一个地址。
   */
  const deep = /^\/review\/(wf-[A-Za-z0-9_-]+)$/.exec(path ?? "");
  if (deep) {
    window.location.hash = `#/?open=review&run=${deep[1]}`;
    return;
  }

  const section = params.get("s");
  const card = (section && LEGACY[`/${section}`]) || LEGACY[path];
  // 设置 is a drawer rather than a card, and the workspace itself is the address.
  if (
    path === "/settings" ||
    path === "/projects" ||
    path === "/model" ||
    path === "/chain" ||
    path === "/processes" ||
    path === "/capabilities"
  ) {
    window.location.hash = "#/";
    return;
  }
  if (card) window.location.hash = `#/?open=${card}`;
  else if (path !== "/" && path !== "/workspace" && path !== "/canvas") window.location.hash = "#/";
  else if (path !== "/") window.location.hash = query ? `#/?${query}` : "#/";
}

export function App() {
  const [, force] = useState(0);
  useEffect(() => {
    normalise();
    const onHash = () => {
      normalise();
      force((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return <AppShell />;
}

/**
 * 外壳：左导航 + 一屏。
 *
 * 这是本轮唯一的结构性改动，而它**没有动地址机制**：仍然是那一个地址加 `?open=`，
 * 旧链接（`#/?open=review&run=wf-xxx`）照样能打开。换的只是它渲染成盖在画布上的
 * 一张浮层，还是渲染成一屏。
 *
 * 为什么要换：九个工具族的调研里，十个 review-heavy 的产品**没有一个**把画布放在中心；
 * 而「每类产物一张卡」随类型数线性劣化——13 类就是 13 张卡，人仍然要先在脑子里建一张
 * 地图，只是那张地图从菜单换成了画布。
 */
function AppShell() {
  const t = useT();
  const [open, setOpen] = useState(readOpen);
  useEffect(() => {
    const onHash = () => setOpen(readOpen());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /**
   * 项目列表在**外壳**里加载，不在画布里。
   *
   * 这是左导航带出的第二个回归：`loadData()` 原来只挂在画布那一屏的挂载 effect 上，
   * 而深链（`#/?open=review`）根本不挂载画布——于是直接打开一条链接时，
   * 项目一个都没加载，左导航 **10 / 14 项恒为灰**，底下写着「未选择项目」，
   * 而人看到的是"这个产品什么都没有"。
   *
   * 「把 URL 复制到另一台机器打开同一视图」是 U-42 的验收判据之一，
   * 数据不在外壳加载，那条判据永远过不了。
   */
  const loadData = useStore((s) => s.loadData);
  const selectProject = useStore((s) => s.selectProject);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  useEffect(() => {
    void loadData();
  }, [loadData]);

  /**
   * 回到上次那个项目。
   *
   * `loadData` 有意不自动选中——它的注释说「组合视图是默认落地页」，那是上一版骨架的
   * 前提；这一版的默认落点是复核队列，它必须有项目才有内容。不在这里恢复的话，
   * 每次打开都是一张 10/14 项置灰的导航，底下写着「未选择项目」，
   * 而人看到的是"这个产品什么都没有"。
   *
   * 记住的 id 不存在了就退回第一个：项目被删掉之后，一个指向空处的记忆比没有记忆更糟。
   */
  useEffect(() => {
    if (activeProjectId || !projects.length) return;
    const remembered = safeGet(LAST_PROJECT);
    const want = projects.find((p) => p.id === remembered) ?? projects[0];
    if (want) void selectProject(want.id);
  }, [projects, activeProjectId, selectProject]);

  useEffect(() => {
    if (activeProjectId) safeSet(LAST_PROJECT, activeProjectId);
  }, [activeProjectId]);

  const go = (id: string, extra?: Record<string, string>) => {
    /**
     * 换落点时**保住 `run`**，扔掉别的。
     *
     * 与 Workspace 里那段 `useOpenSurface` 同一条规矩、同一个理由：一个只有一个地址的
     * 应用，地址里那几个参数就是它全部的状态。此前从产品地图切到复核，`run` 就没了，
     * 人正在看的那一次运行悄悄变回「最近那一次」。
     */
    const [path, query] = window.location.hash.split("?");
    const keep = new URLSearchParams();
    const run = new URLSearchParams(query ?? "").get("run");
    if (run) keep.set("run", run);
    if (id) keep.set("open", id);
    for (const [k, v] of Object.entries(extra ?? {})) keep.set(k, v);
    const q = keep.toString();
    window.location.hash = `${path || "#/"}${q ? `?${q}` : ""}`;
    setOpen(id);
  };

  const surface = open && open !== CANVAS ? surfaceById(open) : undefined;
  /**
   * 复核徽标上的数字：还没被人决定过的用例。
   *
   * 用 `runStatus === "notRun"` 只是个近似——真正的「待复核」在复核队列自己的口径里。
   * 这里要的只是「有没有事等着人做」，宁可粗一点也不要多开一条口径：
   * 两个口径会长出两个不同的数字，而人会以为其中一个坏了。
   */
  const pending = useStore((s) => s.cases.filter((c) => c.runStatus === "notRun").length);

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <AppNav current={navIdFor(open)} onGo={go} reviewCount={pending || undefined} />
      <CommandPalette onGo={go} />
      <Shortcuts />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/*
         * `?open=canvas`（以及任何认不出的 `?open=` 值）落在这里，画的是搬迁空态而不是
         * 画布本身——见 `docs/v3/00-架构.md` §1/§2、§6（US-14 是 22 条用户故事里变差的
         * 两条之一）：工作流的编排与运行整个换成了 PenguinHarness，画布画的正是这些。
         *
         * **v3 Phase 3：这条拦截从 `pages/Workspace.tsx` 挪到了这里。** 那个文件此前导出
         * 一个 `WorkspacePage`，函数体只有一行 `return <MigratedToPenguin />`——真正的画布
         * 代码在同一文件里的 `LegacyCanvasPage`，从没被这一行调用过。拦截该在应用入口
         * 判断"这条地址该看什么"，不该借一个页面文件的名字转一手：那一行除了多一层
         * 无用的缩进，不代表画布对这条地址还有发言权。`LegacyCanvasPage` 与它的代码、
         * 注释原样留着（Phase 3 之后的事，见该文件的文件头注释），只是没有任何路径
         * 再引用它。
         */}
        {surface ? <SurfaceScreen id={surface.id} title={t(surface.title)} onGo={go} /> : <MigratedToPenguin />}
      </div>
    </div>
  );
}

const LAST_PROJECT = "tp.lastProject";

/**
 * 读地址里的 `?open=`，并决定**没写时落在哪**。
 *
 * 默认是复核队列，不是画布——复核是这个产品每天要做上百次的事，其余是每周几次的。
 * 但 `?run=` 在场时落回运行那一屏：一个带着运行 id 的链接，意思就是「看这一次运行」，
 * 把它落到复核上会让别人发来的链接指向另一件事。旧链接因此照样成立。
 */
function readOpen(): string {
  const p = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const open = p.get("open");
  if (open !== null) return open;
  return p.get("run") ? CANVAS : "review";
}

/** 画布（工作流运行那一屏）在地址里的名字。空串曾经是它，但空串现在表示「没写」。 */
export const CANVAS = "canvas";

/**
 * 一个界面占满一屏。
 *
 * 页面本身一行没改：它们各自渲染自己的 TopBar，所以这里**不再**套 `InSectionProvider`
 * ——那个标志是给抽屉用的（抽屉自己已经有标题栏，页面的 TopBar 会变成第二个页头）。
 * 占满一屏时，页面的 TopBar 就是这一屏的页头。
 */
function SurfaceScreen({ id, title, onGo }: { id: string; title: string; onGo: (id: string) => void }) {
  const t = useT();
  const s = surfaceById(id);
  const [ctx, setCtx] = useState(readCtx);
  useEffect(() => {
    const onHash = () => setCtx(readCtx());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (!s) return null;
  /*
   * 同组的其它界面。页头（`TopBar`）会把它们画成一排 tab——
   * 这是左导航从 18 项收到 11 项之后，那些界面的去处。
   *
   * 一组里每一项都已经在左导航上时不画（配置组就是这样）：那只是把导航抄了一遍，
   * 而两处说同一件事，人会以为它们是两件事。
   */
  const siblings = surfacesInGroup(s.group);
  const tabs = siblings.some((x) => !navItemFor(x.id))
    ? siblings.map((x) => ({ id: x.id, label: t(x.title) }))
    : [];
  return (
    <SurfaceTabsProvider value={{ tabs, current: id, onSwitch: onGo }}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-surface={id} aria-label={title}>
        {s.render(ctx)}
      </div>
    </SurfaceTabsProvider>
  );
}

/** 界面的上下文来自地址：哪一次运行、落在哪一处。放在 URL 里，链接才发得出去。 */
function readCtx(): { wfRunId?: string; focus?: string } {
  const p = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return { wfRunId: p.get("run") ?? undefined, focus: p.get("at") ?? undefined };
}
