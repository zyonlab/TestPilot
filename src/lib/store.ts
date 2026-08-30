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
  createProject: (
    name: string,
    targetUrl: string,
    targetPlatform?: TargetPlatform,
    materials?: string[],
  ) => Promise<void>;
  /** Rename / re-point / switch ends. */
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "targetUrl" | "targetPlatform">>) => Promise<void>;
  select: (id: string) => void;
  patchCase: (id: string, patch: Partial<TestCase>) => Promise<void>;
  setPriority: (id: string, p: Priority) => Promise<void>;
  generateCode: (id: string) => Promise<void>;
  runCase: (id: string) => Promise<void>;
  runAllP0: () => void;
  setModel: (patch: Partial<ModelConfig>) => void;
  testConnection: () => Promise<void>;
}

export const useStore = create<StoreState>((set, get) => ({
  cases: [],
  selectedId: "",
  runs: [],
  projects: [],
  overviews: {},
  activeProjectId: "",
  backendUp: false,
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

  // Load projects/cases/runs from the backend (source of truth). Falls back to the
  // built-in mock data if the backend is offline, so the UI still works standalone.
  loadData: async () => {
    try {
      const { projects, overviews } = await api.getProjects();
      if (!projects.length) {
        // Backend is up but has no projects → a genuinely empty state. Clear the
        // built-in mock data (which is only a fallback for when the backend is OFFLINE),
        // otherwise the UI shows a phantom "shop.acme.com" project + mock cases.
        set({
          backendUp: true,
          projects: [],
          overviews: {},
          activeProjectId: "",
          cases: [],
          runs: [],
          flakiness: [],
          selectedId: "",
          exploreLastCount: 0,
          exploreScreenshot: "",
        });
        return;
      }
      // Backend is up and has projects. Do NOT auto-select — Level 0 (the portfolio)
      // is the default landing. Cases/runs load lazily on enter (selectProject).
      set({ projects, overviews: overviews ?? {}, activeProjectId: "", backendUp: true });
    } catch {
      set({ backendUp: false }); // keep mock data
    }
  },

  loadFlakiness: async () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    try {
      const { flakiness } = await api.getFlakiness(pid);
      set({ flakiness });
    } catch {
      set({ flakiness: [] }); // backend offline / no data
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
        cases: s.cases.map((c) =>
          c.id === id ? { ...c, quarantined: !quarantined } : c,
        ),
      }));
    }
  },

  // Switch the active project → load its cases from the backend.
  selectProject: async (id) => {
    const proj = get().projects.find((p) => p.id === id);
    if (!proj) return;
    try {
      const [{ cases }, { runs }] = await Promise.all([
        api.getCases(id),
        api.getRuns({ projectId: id }),
      ]);
      set({
        activeProjectId: id,
        cases,
        runs, // project-scoped: Runs page now follows the active project
        selectedId: cases[0]?.id ?? "",
      });
      void get().loadFlakiness();
    } catch {
      /* backend offline */
    }
  },

  // Leave the project → return to the portfolio (Level 0). Clears project-scoped data.
  exitProject: () =>
    set({
      activeProjectId: "",
      cases: [],
      runs: [],
      flakiness: [],
      selectedId: "",
    }),

  createProject: async (name, targetUrl, targetPlatform = "web", materials = []) => {
    try {
      const { project } = await api.createProject(name, targetUrl, targetPlatform, materials);
      set((s) => ({ projects: [...s.projects, project] }));
      await get().selectProject(project.id);
    } catch {
      /* backend offline */
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
    } catch {
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, runStatus: "failed" } : c)) }));
    }
  },

  runAllP0: () => {
    const p0 = get().cases.filter((c) => c.priority === "P0");
    p0.forEach((c, i) => window.setTimeout(() => void get().runCase(c.id), i * 300));
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
