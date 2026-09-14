import { Component, type ReactNode } from "react";
import { tOutsideReact } from "@/lib/prefs";
import { CaseBody } from "./CaseCard";
import { StoryTitle } from "./StoryCard";
import { Findings } from "./Findings";
import type { ArtifactCase, ArtifactFinding, ArtifactStory } from "./types";

/**
 * 产物呈现的登记处，以及一层不让单个组件带塌整条消息的围栏。
 *
 * ## 为什么是宿主决定组件，而不是模型决定
 *
 * 「Generative UI」有强弱两个版本：弱版本是模型产出受约束的结构化数据、**宿主**按类型
 * 选组件；强版本是模型自己决定渲染什么。这个仓库已经为强版本付过两次代价
 * （三千字符的列头、被拼死的英文句子，见 `docs/archive/refactor/16-GenerativeUI.md`），
 * 而想要的那件事——「新增一种产物呈现时模型侧不需要改」——弱版本本来就给。
 *
 * 所以这里登记的是**类型 → 组件**。加一种产物呈现，改的是这张表和一个 React 文件；
 * 提示词、schema、模型侧一个字都不用动。
 *
 * ## 为什么每个组件外面要包一层
 *
 * 一条消息里可以挂十几张产物卡。没有围栏时，第十三张卡上一个 `undefined.map` 会让
 * 整条消息变成白屏——包括前面十二张本来渲染得好好的。而产物数据来自模型，
 * 「某个字段这次没有」正是它最常见的行为。
 */

export interface ArtifactRenderer<T = unknown> {
  /** 这种产物叫什么。与产出它的节点的 outKind 对齐。 */
  kind: string;
  /** 人话名字，给登记处本身的调试视图用。 */
  title: string;
  render(value: T): ReactNode;
}

const REGISTRY = new Map<string, ArtifactRenderer>();

/** 登记一种产物的呈现方式。重复登记按后来的算——热更新时它会跑两遍。 */
export function registerArtifact<T>(r: ArtifactRenderer<T>): void {
  REGISTRY.set(r.kind, r as ArtifactRenderer);
}

export const rendererFor = (kind: string): ArtifactRenderer | undefined => REGISTRY.get(kind);

/** 登记过哪些。给「这一版认得几种产物」这类问题一个能查的答案。 */
export const registeredKinds = (): string[] => [...REGISTRY.keys()];

/**
 * 一个组件塌了，只塌它自己。
 *
 * 这是整个登记处存在的另一半理由：产物数据来自模型，而「某个字段这次没有」是它
 * 最常见的行为。一条消息里十三张卡，第十三张上的一个 `undefined.map`
 * 不该把前面十二张一起变成白屏。
 */
export class ArtifactBoundary extends Component<{ children: ReactNode; kind: string }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    // 说清楚是哪一种产物塌了、塌在哪句话上——一个只写着「出错了」的框，
    // 跟白屏对读的人来说是同一件事。
    return (
      <div className="rounded-lg border border-bad bg-bad-soft p-2 text-[0.75rem] text-bad">
        <div className="font-medium">{tOutsideReact("artifact.renderFailed", { kind: this.props.kind })}</div>
        <div className="mt-0.5 font-mono text-[0.6875rem] opacity-80">{this.state.error.message}</div>
        <div className="mt-0.5 opacity-80">{tOutsideReact("artifact.renderFailedWhy")}</div>
      </div>
    );
  }
}

/**
 * 按类型渲染一份产物。
 *
 * 认不出的类型不是错误：这一版可能就是不认得它。给一句说得清的话，
 * 外加原始数据——总好过一个空白。
 */
export function Artifact({ kind, value }: { kind: string; value: unknown }): ReactNode {
  const r = rendererFor(kind);
  if (!r)
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-2 text-[0.75rem] text-muted-foreground">
        <div>{tOutsideReact("artifact.unknownKind", { kind })}</div>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem]">
          {JSON.stringify(value, null, 1)}
        </pre>
      </div>
    );
  return <ArtifactBoundary kind={kind}>{r.render(value)}</ArtifactBoundary>;
}

/* ---- 这一版认得的产物 ----
 *
 * 加一种呈现，就在这里多写一条 `registerArtifact`，外加一个 React 文件。
 * 提示词、schema、模型侧一个字都不用动——这就是「宿主决定组件」的全部含义。
 */
registerArtifact<ArtifactCase>({
  kind: "case",
  title: tOutsideReact("artifact.kind.textcase"),
  render: (kase) => <CaseBody kase={kase} />,
});

registerArtifact<ArtifactStory>({
  kind: "story",
  title: tOutsideReact("artifact.kind.story"),
  render: (story) => <StoryTitle story={story} />,
});

registerArtifact<ArtifactFinding[]>({
  kind: "findings",
  title: tOutsideReact("artifact.kind.finding"),
  render: (findings) => <Findings findings={findings} />,
});
