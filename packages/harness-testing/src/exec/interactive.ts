// Interactive sessions: exploration and step-by-step debugging.
//
// Unlike a case run, these are *streamed* — the UI watches the page while the model
// thinks. They emit frames instead of returning one result, and screenshots leave as file
// refs: the frames also land in lineage, and lineage must not fill up with base64 JPEGs.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveText, redact, withModel, type ResolveContext } from "@testpilot/harness-core";
import { launchSession, type LaunchOpts, type Session } from "./session.js";
import { isInfraError } from "../failure.js";

export type Emit = (evt: Record<string, unknown>) => void;

/** Cooperative cancellation: the UI closing the stream must stop the work, not orphan it. */
export interface CancelToken {
  cancelled: boolean;
}

export interface ExploreSpec {
  execId: string;
  url: string;
  artifactDir: string;
  /** Fully composed prompt (settings template + language directive) — the gateway owns prompts. */
  prompt: string;
  /** Present when a deep crawl is requested: the prompt to use after advancing one screen. */
  deepPrompt?: string;
  /** Dapp explores wait for the app to detect the injected wallet before planning. */
  settleMs?: number;
  launch: LaunchOpts;
}

export interface ExploreResult {
  /** Raw flow objects from the model. Turning them into cases needs the DB, so the gateway does it. */
  flows: unknown[];
  log: string[];
  shotRef?: string;
}

export interface DebugSpec {
  execId: string;
  url: string;
  artifactDir: string;
  plan: Array<{ text: string; kind: "login" | "step" }>;
  expected?: string;
  /** Free-text hint passed to Midscene as action context. */
  hint?: string;
  resolve: ResolveContext;
  launch: LaunchOpts;
}

function shooter(spec: { execId: string; artifactDir: string }) {
  const dir = resolve(spec.artifactDir, "live");
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async (session: Session | undefined): Promise<string | undefined> => {
    if (!session) return undefined;
    try {
      const buf = await session.page.screenshot({ type: "jpeg", quality: 55 });
      const path = resolve(dir, `${spec.execId}-${n++}.jpg`);
      writeFileSync(path, buf);
      return path;
    } catch {
      return undefined; // a missed frame must never fail the session
    }
  };
}

export interface ObserveSpec {
  execId: string;
  url: string;
  artifactDir: string;
  /** 多走一屏：登录之后的界面从入口页上看不见。 */
  deep?: boolean;
  settleMs?: number;
  launch: LaunchOpts;
}

export interface ObserveResult {
  /** 观察到的界面材料，逐屏。原样，不经任何解释。 */
  notes: string;
  url: string;
  log: string[];
  shotRef?: string;
}

/**
 * 看一眼跑着的产品，把界面上有什么**原样**取回来。
 *
 * 和 `runExplore` 的关键区别：这里**不问模型「这该怎么测」**。采集是确定性的——标题、正文、
 * 每个可点可填的控件及其可见文案——因为下游 `spec.compose` 要求「逐字引用界面文案」，
 * 而一段被模型转述过的描述，引出来的文案是它记得的样子，不是屏幕上的样子。
 *
 * 唯一用到模型的地方是「往前走一屏」这个动作：登录之后的界面从入口页上看不见，
 * 而怎么登录需要看着页面判断。那是**操作**，不是解释。
 */
export async function runObserve(
  spec: ObserveSpec,
  emit: Emit,
  token: CancelToken = { cancelled: false },
): Promise<ObserveResult> {
  const shot = shooter(spec as unknown as ExploreSpec);
  const log: string[] = [];
  const note = (message: string, kind: "info" | "warn" = "info") => {
    log.push(message);
    emit({ type: "log", message, kind });
  };
  let session: Session | undefined;

  /** 一屏的事实：地址、标题、正文、可交互控件的可见文案。 */
  const snapshot = async (label: string): Promise<string> => {
    const page = session!.page as unknown as {
      url(): string;
      title(): Promise<string>;
      evaluate<T>(fn: () => T): Promise<T>;
    };
    const title = await page.title().catch(() => "");
    const body = await page
      .evaluate(() => (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 4000))
      .catch(() => "");
    const controls = await page
      .evaluate(() =>
        [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button]")]
          .slice(0, 60)
          .map((el) => {
            const e = el as HTMLElement & { placeholder?: string; value?: string; type?: string };
            const label =
              (e.innerText || "").trim() ||
              e.getAttribute("aria-label") ||
              e.placeholder ||
              e.getAttribute("name") ||
              "";
            return `${el.tagName.toLowerCase()}${e.type ? `[${e.type}]` : ""}: ${label.slice(0, 60)}`;
          })
          .filter((x) => x.split(": ")[1]),
      )
      .catch(() => [] as string[]);

    return [
      `===== ${label} =====`,
      `URL: ${page.url()}`,
      title ? `TITLE: ${title}` : "",
      "",
      "TEXT:",
      body,
      "",
      "CONTROLS:",
      ...controls.map((c) => `- ${c}`),
    ]
      .filter((x) => x !== "")
      .join("\n");
  };

  try {
    emit({ type: "start", url: spec.url });
    session = await launchSession(spec.url, spec.launch);
    emit({ type: "navigated", shotRef: await shot(session) });
    if (spec.settleMs) await new Promise((r) => setTimeout(r, spec.settleMs));

    const screens = [await snapshot("入口页")];
    note(`入口页：${screens[0].length} 字`);

    if (spec.deep && !token.cancelled) {
      try {
        note("往前走一屏…");
        await withModel(() =>
          session!.agent.aiAction(
            "If a login form is present, log in using any test/demo credentials shown on " +
              "this page; otherwise click the primary button to enter the application.",
          ),
        );
        await new Promise((r) => setTimeout(r, 1500));
        emit({ type: "navigated", shotRef: await shot(session) });
        screens.push(await snapshot("前进一屏后"));
        note(`第二屏：${screens[1].length} 字`);
      } catch (e) {
        // 走不进去本身就是观察结果的一部分：下游会把它记成「没看到的」。
        note(`没能往前走：${(e as Error).message.slice(0, 70)}`, "warn");
        screens.push(`===== 前进一屏 =====\n没能进入：${(e as Error).message.slice(0, 200)}`);
      }
    }

    return {
      notes: screens.join("\n\n"),
      url: spec.url,
      log,
      shotRef: await shot(session),
    };
  } finally {
    await session?.cleanup();
  }
}

export async function runExplore(
  spec: ExploreSpec,
  emit: Emit,
  token: CancelToken = { cancelled: false },
): Promise<ExploreResult> {
  const shot = shooter(spec);
  const log: string[] = [];
  const note = (message: string, kind: "info" | "warn" = "info") => {
    log.push(message);
    emit({ type: "log", message, kind });
  };
  let session: Session | undefined;
  // The page keeps changing while a single aiQuery runs for tens of seconds; without this
  // the UI would show one frozen frame and look hung.
  let beat: ReturnType<typeof setInterval> | undefined;
  const startBeat = () => {
    stopBeat();
    beat = setInterval(async () => {
      if (token.cancelled) return;
      const shotRef = await shot(session);
      if (shotRef && !token.cancelled) emit({ type: "navigated", shotRef });
    }, 4000);
  };
  const stopBeat = () => {
    if (beat) clearInterval(beat);
    beat = undefined;
  };

  try {
    emit({ type: "start", url: spec.url });
    session = await launchSession(spec.url, spec.launch);
    emit({ type: "navigated", shotRef: await shot(session) });
    if (spec.settleMs) await new Promise((r) => setTimeout(r, spec.settleMs));

    startBeat();
    const flows = asArray(await withModel(() => session!.agent.aiQuery(spec.prompt)));
    stopBeat();
    if (token.cancelled) return { flows: [], log };
    note(`entry page → ${flows.length} flows`);
    emit({ type: "flows", flows });

    if (spec.deepPrompt) {
      try {
        note("Advancing one screen (deep crawl)…");
        await withModel(() =>
          session!.agent.aiAction(
            "If a login form is present, log in using any test/demo credentials shown on " +
              "this page; otherwise click the primary button to enter the application.",
          ),
        );
        await new Promise((r) => setTimeout(r, 1500));
        emit({ type: "navigated", shotRef: await shot(session) });
        startBeat();
        const deeper = asArray(await withModel(() => session!.agent.aiQuery(spec.deepPrompt!)));
        stopBeat();
        flows.push(...deeper);
        note(`advanced one screen → ${deeper.length} more flows`);
        emit({ type: "flows", flows: deeper });
      } catch (e) {
        stopBeat();
        note(`deep crawl skipped: ${(e as Error).message.slice(0, 70)}`, "warn");
      }
    }
    return { flows, log, shotRef: await shot(session) };
  } finally {
    stopBeat();
    await session?.cleanup();
  }
}

export async function runDebug(
  spec: DebugSpec,
  emit: Emit,
  token: CancelToken = { cancelled: false },
): Promise<void> {
  const shot = shooter(spec);
  const ctx = spec.resolve;
  const secretVals = Object.values(ctx.secrets ?? {});
  const safe = (t: string) => redact(t, secretVals);
  let session: Session | undefined;
  let idx = 0;

  try {
    emit({
      type: "start",
      url: spec.url,
      steps: spec.plan.map((p) => ({ text: safe(p.text), kind: p.kind })),
      hint: spec.hint || undefined,
    });
    // Fresh session, no cacheId → the model replans (true debug, not cache replay).
    session = await launchSession(spec.url, spec.launch);
    if (spec.hint) {
      try {
        (session.agent as { setAIActionContext?: (h: string) => void }).setAIActionContext?.(spec.hint);
      } catch {
        /* older Midscene without action-context — hint is best-effort */
      }
    }
    emit({ type: "navigated", shotRef: await shot(session) });

    for (const step of spec.plan) {
      if (token.cancelled) return;
      emit({ type: "step", idx, kind: step.kind, text: safe(step.text), status: "running" });
      await withModel(() => session!.agent.aiAction(resolveText(step.text, ctx)));
      if (token.cancelled) return;
      emit({
        type: "step",
        idx,
        kind: step.kind,
        text: safe(step.text),
        status: "done",
        shotRef: await shot(session),
      });
      idx += 1;
    }

    if (!spec.expected) {
      emit({ type: "done", status: "passed" });
      return;
    }
    if (token.cancelled) return;
    emit({ type: "assert", assertion: spec.expected, status: "running" });
    try {
      await withModel(() => session!.agent.aiAssert(resolveText(spec.expected!, ctx)));
      emit({ type: "assert", assertion: spec.expected, status: "pass", shotRef: await shot(session) });
      emit({ type: "done", status: "passed" });
    } catch (e) {
      const detail = safe((e as Error).message);
      emit({ type: "assert", assertion: spec.expected, status: "fail", detail, shotRef: await shot(session) });
      emit({ type: "done", status: "failed", failedIdx: idx, failedKind: "assert" });
    }
  } catch (e) {
    const message = safe((e as Error).message);
    // An infra failure means "no verdict", not "the test failed" — the UI colours it differently.
    emit({ type: "step", idx, status: "fail", detail: message, shotRef: await shot(session) });
    emit({ type: "done", status: isInfraError(message) ? "error" : "failed", failedIdx: idx, message });
  } finally {
    await session?.cleanup();
  }
}

function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const flows = (data as { flows?: unknown })?.flows;
  return Array.isArray(flows) ? flows : [];
}
