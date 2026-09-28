import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/base";
import type { Lang } from "@/lib/i18n";
import type { TargetPlatform } from "@/lib/types";

/**
 * 内置示例清单（服务端 `GET /api/examples`，数据在仓库 `examples/*\/example.json`）。
 *
 * 示例叫什么、填哪个地址、起草提示怎么说都是项目数据，界面只认这份清单的形状，
 * 不认识任何一个具体示例。
 */
export type LocalText = Record<Lang, string>;
export interface ExampleInfo {
  id: string;
  title: LocalText;
  label: LocalText;
  projectHint?: LocalText;
  draftTitle?: LocalText;
  project: { name: string; targetUrl: string; platform: TargetPlatform; explorationScope?: "current-url" | "rules" };
  draftPrompts?: { base: LocalText; domainKnowledge?: LocalText; domainReference?: LocalText; rulePack?: LocalText };
  hasDomainKnowledge: boolean;
  hasRulePack: boolean;
}

let pending: Promise<ExampleInfo[]> | null = null;
function fetchExamples(): Promise<ExampleInfo[]> {
  pending ??= fetch(`${API_BASE}/api/examples`)
    .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return ((await r.json()).examples ?? []) as ExampleInfo[]; })
    .catch(() => { pending = null; return []; });
  return pending;
}

/** 读不到清单就当没有示例：示例是锦上添花，不该挡住建项目或起草。 */
export function useExamples(): ExampleInfo[] {
  const [examples, setExamples] = useState<ExampleInfo[]>([]);
  useEffect(() => { let live = true; void fetchExamples().then((x) => { if (live) setExamples(x); }); return () => { live = false; }; }, []);
  return examples;
}

export function hostOf(url: string | undefined): string | null {
  try { return new URL(url ?? "").hostname || null; } catch { return null; }
}

/** 项目地址的主机与任一示例的地址主机相同，就当它是那个示例的项目。 */
export function exampleForUrl(examples: ExampleInfo[], url: string | undefined): ExampleInfo | undefined {
  const host = hostOf(url);
  return host ? examples.find((e) => hostOf(e.project.targetUrl) === host) : undefined;
}
