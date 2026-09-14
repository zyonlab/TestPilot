import { create } from "zustand";
import type {
  ConnectionState,
  Flakiness,
  ModelConfig,
  Priority,
  Project,
  ProjectOverview,
  RunRecord,
  TargetPlatform,
  TestCase,
} from "./types";
import { api } from "./api";

interface StoreState {
  cases: TestCase[];
  selectedId: string;
  runs: RunRecord[];
  projects: Project[];
  /** 每个项目的两套账：已批准的资产 与 还没人看的候选。见 ProjectOverview 的注释。 */
  overviews: Record<string, ProjectOverview>;
  activeProjectId: string;
  backendUp: boolean;
  projectsLoading: boolean;
  projectsError: boolean;
  projectDataLoading: boolean;
  projectDataError: boolean;
  model: ModelConfig;
  connection: ConnectionState;
  connectionDetail: string;
  exploreScreenshot: string;
  exploreLastCount: number;
  flakiness: Flakiness[];

  loadData: () => Promise<void>;
  loadFlakiness: () => Promise<void>;

  setQuarantine: (id: string, quarantined: boolean) => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  exitProject: () => void;
  /** 建成了就把它交出来；后端不通时返回 `undefined`——调用方得能分辨这两种情况。 */
  createProject: (
    name: string,
    targetUrl: string,
    targetPlatform?: TargetPlatform,
    materials?: string[],
  ) => Promise<Project | undefined>;
  /** Rename / re-point / switch ends. */
  updateProject: (
    id: string,
    patch: Partial<Pick<Project, "name" | "targetUrl" | "targetPlatform">>,
  ) => Promise<void>;
  select: (id: string) => void;
  patchCase: (id: string, patch: Partial<TestCase>) => Promise<void>;
  setPriority: (id: string, p: Priority) => Promise<void>;
  generateCode: (id: string) => Promise<void>;
  runCase: (id: string) => Promise<void>;
  runAllP0: () => Promise<void>;
  setModel: (patch: Partial<ModelConfig>) => void;
  testConnection: () => Promise<void>;
}

let projectSelection = 0;
let projectListLoad: Promise<void> | undefined;

export const useStore = create<StoreState>((set, get) => ({
  cases: [],
  selectedId: "",
  runs: [],
  projects: [],
  overviews: {},
  activeProjectId: "",
  backendUp: false,
  projectsLoading: false,
  projectsError: false,
  projectDataLoading: false,
  projectDataError: false,
  model: {
    // The model endpoint itself. The no-think proxy (:8010) is a capability you can start
    // from the Processes page when you want prompts/responses captured for tuning; it is
    // not on the default path. Matches server/.env.
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "1234",
    modelName: "Qwen3.8-27B-4bit",
    modelFamily: "qwen-vl",
  },
  connection: "idle",
  connectionDetail: "",
  exploreScreenshot: "",
  exploreLastCount: 0,
  flakiness: [],

  // Refresh the project list without clearing a valid current selection.
  loadData: () => {
    if (projectListLoad) return projectListLoad;
    set({ projectsLoading: true, projectsError: false });
    projectListLoad = (async () => {
    try {
      const { projects, overviews } = await api.getProjects();
      if (!Array.isArray(projects)) throw new Error("Invalid project list response");
      const keepSelection = projects.some((p) => p.id === get().activeProjectId);
      set({
        projects, overviews: overviews ?? {}, backendUp: true,
        ...(!keepSelection ? {
          activeProjectId: "", cases: [], runs: [], flakiness: [], selectedId: "",
          exploreLastCount: 0, exploreScreenshot: "", projectDataLoading: false, projectDataError: false,
        } : {}),
      });
    } catch (error) {
      console.warn("[TestPilot] Project loading failed", error);
      set({ backendUp: false, projectsError: true });
    } finally {
      set({ projectsLoading: false });
      projectListLoad = undefined;
    }
    })();
    return projectListLoad;
  },

  loadFlakiness: async () => {
    const pid = get().activeProjectId, selection = projectSelection;
    if (!pid) return;
    try {
      const { flakiness } = await api.getFlakiness(pid);
      if (get().activeProjectId === pid && selection === projectSelection) set({ flakiness });
    } catch {
      if (get().activeProjectId === pid && selection === projectSelection) set({ flakiness: [] });
    }
  },

  setQuarantine: async (id, quarantined) => {
    // optimistic
    set((s) => ({
      cases: s.cases.map((c) => (c.id === id ? { ...c, quarantined } : c)),
    }));
    try {
      const { case: updated } = await api.setQuarantine(id, quarantined);
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
    } catch {
      // revert on failure
      set((s) => ({
        cases: s.cases.map((c) => (c.id === id ? { ...c, quarantined: !quarantined } : c)),
      }));
    }
  },

  // Select immediately: history loading must not disable workflows or project settings.
  selectProject: async (id) => {
    if (!get().projects.some((p) => p.id === id)) return;
    const selection = ++projectSelection;
    set({ activeProjectId: id, cases: [], runs: [], flakiness: [], selectedId: "",
      projectDataLoading: true, projectDataError: false });
    const [cases, runs] = await Promise.allSettled([api.getCases(id), api.getRuns({ projectId: id })]);
    // A late response must not replace another project's data (including A → B → A).
    if (selection !== projectSelection || get().activeProjectId !== id) return;
    set({
      cases: cases.status === "fulfilled" ? cases.value.cases : [],
      runs: runs.status === "fulfilled" ? runs.value.runs : [],
      selectedId: cases.status === "fulfilled" ? cases.value.cases[0]?.id ?? "" : "",
      projectDataLoading: false,
      projectDataError: cases.status === "rejected" || runs.status === "rejected",
    });
    void get().loadFlakiness();
  },

  // Leave the project → return to the portfolio (Level 0). Clears project-scoped data.
  exitProject: () => {
    ++projectSelection;
    set({
      activeProjectId: "",
      cases: [],
      runs: [],
      flakiness: [],
      selectedId: "",
      projectDataLoading: false,
      projectDataError: false,
    });
  },

  createProject: async (name, targetUrl, targetPlatform = "web", materials = []) => {
    try {
      const { project } = await api.createProject(name, targetUrl, targetPlatform, materials);
      set((s) => ({ projects: [...s.projects, project] }));
      await get().selectProject(project.id);
      return project;
    } catch {
      // 后端不通。此前这里静默返回，于是「建好了」和「一个字都没写进去」在界面上
      // 长得一模一样——表单关掉、列表照旧，人只会以为自己点漏了。
      return undefined;
    }
  },

  updateProject: async (id, patch) => {
    // Optimistic, then reconciled: the end switch changes what the rest of the UI offers,
    // and a dropdown that snaps back while a request is in flight reads as a rejection.
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
    try {
      const { project } = await api.updateProject(id, patch);
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
    } catch {
      await get().loadData();
    }
  },

  select: (id) => set({ selectedId: id }),

  // Generic case patcher (steps/expected/etc.). Optimistic; falls back to the
  // backend's canonical row when online. Used by the AI-refine accept flow.
  patchCase: async (id, patch) => {
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    if (get().backendUp) {
      try {
        const { case: updated } = await api.patchCase(id, patch);
        set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
      } catch {
        /* kept optimistic */
      }
    }
  },

  setPriority: async (id, p) => {
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, priority: p } : c)) }));
    if (get().backendUp) {
      try {
        await api.patchCase(id, { priority: p });
      } catch {
        /* kept optimistic */
      }
    }
  },

  generateCode: async (id) => {
    if (!get().backendUp) return;
    try {
      const { case: updated } = await api.genCaseCode(id);
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
    } catch {
      /* backend error — leave the case unchanged */
    }
  },

  runCase: async (id) => {
    if (!get().cases.some((c) => c.id === id) || !get().backendUp) return;
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, runStatus: "running" } : c)) }));
    try {
      const { case: updated } = await api.runCaseApi(id, {});
      // Single-case runs do NOT enter s.runs — the Runs page is the suite ledger.
      // The case detail shows this run inline (fetched by caseId).
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
    } catch (e) {
      /**
       * 请求没回来 ≠ 这条用例失败了。
       *
       * 此前这里一律写 `runStatus:"failed"`——**界面记下了一个它从没收到过的判决**。
       * 600 秒超时、网络抖动、网关重启，全都会变成一条红色的用例，而它可能跑得好好的。
       * 「没拿到结果」是它自己的状态，理由要留着，人才知道该重试还是该去看代码。
       */
      set((s) => ({
        cases: s.cases.map((c) =>
          c.id === id ? { ...c, runStatus: "unknown", runNote: (e as Error).message } : c,
        ),
      }));
    }
  },

  /**
   * 跑一批 P0。
   *
   * 走**队列**，不再每 300ms 直接发一个 POST：那条路不进队列，而 runnerCount 默认是 1，
   * `pickRunner` 找不到空闲的就把活交给正忙的那个，runner 抛"runner busy"，
   * 路由 catch 里把用例标成 failed——**把根本没跑成的用例直接标红，而且不留任何记录**。
   */
  runAllP0: async () => {
    const p0 = get().cases.filter((c) => c.priority === "P0");
    if (!p0.length || !get().backendUp) return;
    set((s) => ({
      cases: s.cases.map((c) => (c.priority === "P0" ? { ...c, runStatus: "running" } : c)),
    }));
    try {
      const pid = get().activeProjectId;
      if (!pid) return;
      await api.runSuite(pid, "P0");
      await get().loadData();
    } catch (e) {
      set((s) => ({
        cases: s.cases.map((c) =>
          c.priority === "P0" ? { ...c, runStatus: "unknown", runNote: (e as Error).message } : c,
        ),
      }));
    }
  },

  /*
   * 「探索直接产用例」已经下掉（2026-08-21）：观察现在是**材料**，和用户文档一样先经
   * `spec.compose` 整理成标准规格，再推出故事与用例。观察本身仍然做，在画布上的
   * `source.explore` 节点里。
   */

  setModel: (patch) =>
    set((s) => ({ model: { ...s.model, ...patch }, connection: "idle", connectionDetail: "" })),

  testConnection: async () => {
    set({ connection: "testing", connectionDetail: "" });
    try {
      const r = await api.testModel(get().model);
      set({ connection: r.state, connectionDetail: r.detail });
    } catch {
      set({
        connection: "fail",
        connectionDetail: "Backend offline — could not reach /api/model/test.",
      });
    }
  },
}));
