import { CasesBoard } from "@/pages/CasesBoard";
import { WorkflowRunsPage } from "@/pages/WorkflowRuns";
import { ProjectReview } from "@/pages/ProjectReview";
import { ProductMap } from "@/pages/ProductMap";
import { DatasetsPage } from "@/pages/Datasets";
import { TracePage } from "@/pages/Trace";
import { CodeLinePage, ChangesPage } from "@/pages/CodeLine";
import { Delivery } from "@/pages/Delivery";
import { WorkflowReports } from "@/pages/WorkflowReports";
import { SuitePage } from "@/pages/Suite";
import { BaselinesPage } from "@/pages/Baselines";
import { TrendsPage } from "@/pages/Trends";
import { EvalsPage } from "@/pages/Evals";
import { ScoreboardPage } from "@/pages/Scoreboard";
import { GoldPage } from "@/pages/Gold";
import { ProjectMaterials } from "@/pages/ProjectMaterials";
import { RulePacks } from "@/pages/RulePacks";
import { OnboardPage } from "@/pages/Onboard";
import { SettingsBody } from "@/components/SettingsDrawer";

export interface SurfaceContext {
  wfRunId?: string;
  revisionId?: string;
  focus?: string;
}

export interface Surface {
  id: string;
  group: string;
  title: string;
  render: (ctx: SurfaceContext) => React.ReactNode;
  needsProject?: boolean;
}

export const SURFACES: Surface[] = [
  {
    id: "map",
    group: "explore",
    title: "surface.map",
    render: (ctx) => <ProductMap focusRun={ctx.wfRunId} focus={ctx.focus} />,
  },

  // 用例这一组：同一批用例的三种看法——它是什么、要不要它、它凭什么这么写。
  // 唯一一个吃上下文的：从某次运行的门禁卡点进来，就该停在那一批上。
  {
    id: "review",
    group: "review",
    title: "surface.review",
    render: () => <ProjectReview />,
  },
  { id: "cases", group: "review", title: "surface.cases", render: () => <CasesBoard />, needsProject: true },
  { id: "trace", group: "review", title: "surface.trace", render: () => <TracePage />, needsProject: true },
  { id: "data", group: "data", title: "surface.data", render: () => <DatasetsPage />, needsProject: true },

  // 代码这一组：生成的、能跑的、被改过的，以及怎么进客户的仓库。
  { id: "code", group: "code", title: "surface.code", render: () => <CodeLinePage />, needsProject: true },
  {
    id: "changes",
    group: "code",
    title: "surface.changes",
    render: () => <ChangesPage />,
    needsProject: true,
  },
  {
    id: "deliver",
    group: "deliver",
    title: "surface.deliver",
    render: () => <Delivery />,
    needsProject: true,
  },

  { id: "artifacts", group: "materials", title: "surface.artifacts", render: ctx => <ProjectMaterials focusRun={ctx.wfRunId} revisionId={ctx.revisionId} /> },
  // 规则包和物料并列：两样都是「喂给这个项目的输入」，只是一份是散文、一份是结构化的领域事实。
  { id: "rulepacks", group: "materials", title: "surface.rulePacks", render: () => <RulePacks />, needsProject: true },

  // Fixed product workflow: host and Web runs share the same revisions and approval service.
  { id: "wfruns", group: "workflow", title: "workflow.title", render: ctx => <WorkflowRunsPage focusRun={ctx.wfRunId} />, needsProject: true },
  { id: "batches", group: "exec", title: "surface.batches", render: () => <SuitePage />, needsProject: true },
  // 「执行记录」问的是被测产品跑出了什么，「套件批次」问的是这一批怎么跑的——
  // 同一件事的结果与过程，所以并列成 tab，而不是各占一个导航项。
  { id: "runs", group: "exec", title: "surface.runs", render: () => <WorkflowReports />, needsProject: true },
  {
    id: "baselines",
    group: "baselines",
    title: "surface.baselines",
    render: () => <BaselinesPage />,
    needsProject: true,
  },
  { id: "trends", group: "exec", title: "surface.trends", render: () => <TrendsPage />, needsProject: true },

  // 这一版 harness 自己好不好——量的不是产品，所以它挂在图上，不挂在任何一个节点上。
  { id: "evals", group: "evals", title: "surface.evals", render: () => <EvalsPage /> },
  { id: "scoreboard", group: "evals", title: "surface.scoreboard", render: () => <ScoreboardPage /> },
  { id: "gold", group: "gold", title: "surface.gold", render: () => <GoldPage /> },

  { id: "onboard", group: "config", title: "surface.onboard", render: () => <OnboardPage /> },
  { id: "settings", group: "config", title: "nav.settings", render: () => <SettingsBody /> },
];

export const surfaceById = (id: string): Surface | undefined => SURFACES.find((s) => s.id === id);
export const surfacesInGroup = (group: string): Surface[] => SURFACES.filter((s) => s.group === group);
