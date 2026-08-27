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
  /** 往前走，而不是只看入口页。关掉就退回单屏采集。 */
  deep?: boolean;
  settleMs?: number;
  /**
   * 最多采到几屏。
   *
   * 这是探索的**成本**闸：每往前一屏要花一次模型调用，本地模型一次几十秒。
   */
  maxScreens?: number;
  /**
   * 连续几轮没发现新界面就停。
   *
   * 不用「走满 N 轮」而用「连着 N 轮没有新东西」：一个产品有几屏事先不知道，
   * 走满固定轮数要么半途而废，要么在最后一屏上原地打转还要接着花钱。
   */
  dryRounds?: number;
  launch: LaunchOpts;
}

export interface ObserveResult {
  /** 观察到的界面材料，逐屏。原样，不经任何解释。 */
  notes: string;
  url: string;
  log: string[];
  shotRef?: string;
  /** 走到过几屏，以及为什么停下来——一份材料薄不薄，得能看出是产品小还是探索停早了。 */
  screens?: number;
  stoppedBecause?: string;
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
  const snapshot = async (label: string): Promise<{ text: string; url: string; controls: string[] }> => {
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

    return {
      url: page.url(),
      controls,
      text: [
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
        .join("\n"),
    };
  };

  /**
   * 这一屏是不是没见过的。
   *
   * 只看地址会把同一个列表页的两次分页当成两屏；只看正文会把加载态和加载完当成两屏。
   * 取「地址 + 控件集合」：控件是这一屏**能做什么**，而探索问的正是这个。
   */
  const signatureOf = (screen: { url: string; controls: string[] }): string =>
    `${screen.url.split("?")[0]}|${[...screen.controls].sort().join("|")}`;

  try {
    emit({ type: "start", url: spec.url });
    session = await launchSession(spec.url, spec.launch);
    emit({ type: "navigated", shotRef: await shot(session) });
    if (spec.settleMs) await new Promise((r) => setTimeout(r, spec.settleMs));

    /**
     * 探索是一个循环，不是「看两眼」。
     *
     * 此前这里只往前走一屏就收工：对任何一个登录页之后还有几屏的产品，材料里都缺着大半，
     * 而缺的那部分在下游看不出来——规格照样整理得出来，用例照样生成得出来，只是**系统性地
     * 少了那几屏对应的一切**，最后表现为一个没有解释的覆盖率数字。
     *
     * 停止条件用「连着 N 轮没有新东西」而不是「走满 N 轮」：一个产品有几屏事先不知道。
     */
    const maxScreens = Math.max(1, spec.maxScreens ?? 6);
    const dryLimit = Math.max(1, spec.dryRounds ?? 2);

    const first = await snapshot("入口页");
    const screens: string[] = [first.text];
    const seen = new Set([signatureOf(first)]);
    const visited: string[] = [first.url];
    const missed: string[] = [];
    let stoppedBecause = spec.deep === false ? "只采入口页（deep 关闭）" : "";
    let dry = 0;
    note(`入口页：${first.text.length} 字，${first.controls.length} 个控件`);

    while (spec.deep !== false && !token.cancelled && screens.length < maxScreens && dry < dryLimit) {
      try {
        note(`往前走（第 ${screens.length} 屏 → 第 ${screens.length + 1} 屏）…`);
        await withModel(() =>
          session!.agent.aiAction(
            // 已经去过的地方明说出来。不说，它会在同一个主按钮上来回点，
            // 每一轮都花掉一次模型调用而什么也没多看到。
            "You are exploring this application to see every screen it has. " +
              "If a login form is present, log in using any test/demo credentials shown on this page. " +
              "Otherwise take ONE action that reaches a part of the application not yet visited — " +
              "open a menu item, a list row, the cart, the next step of a flow. " +
              `Already visited: ${visited.slice(-6).join(" , ")}. ` +
              "Do not log out, do not delete anything, and do not submit anything irreversible.",
          ),
        );
        await new Promise((r) => setTimeout(r, spec.settleMs ?? 1500));
        emit({ type: "navigated", shotRef: await shot(session) });

        const next = await snapshot(`第 ${screens.length + 1} 屏`);
        const sig = signatureOf(next);
        if (seen.has(sig)) {
          // 原地打转也要记一笔：它是「这个产品就这么大」和「探索走不动了」之间的区别。
          dry += 1;
          note(`没有新界面（连续 ${dry}/${dryLimit} 次）`, "warn");
          continue;
        }
        seen.add(sig);
        visited.push(next.url);
        screens.push(next.text);
        dry = 0;
        note(`第 ${screens.length} 屏：${next.url}，${next.controls.length} 个控件`);
      } catch (e) {
        // 走不进去本身就是观察结果的一部分：下游会把它记成「没看到的」。
        const why = (e as Error).message.slice(0, 200);
        note(`没能往前走：${why.slice(0, 70)}`, "warn");
        missed.push(why);
        dry += 1;
      }
    }
    if (!stoppedBecause)
      stoppedBecause = token.cancelled
        ? "被取消"
        : screens.length >= maxScreens
          ? `采满 ${maxScreens} 屏的上限`
          : `连续 ${dryLimit} 轮没有发现新界面`;
    note(`探索结束：${screens.length} 屏，${stoppedBecause}`);

    /**
     * 走到过什么、以及**没走到什么**，一起交出去。
     *
     * 后半句是这份材料唯一能自证薄不薄的地方：`spec.compose` 被要求把材料没说的记进
     * 「没有答案的地方」，而它只有在材料自己说了「这里我没看到」的时候才做得到。
     */
    const coverage = [
      "===== 这次探索走到哪为止 =====",
      `采到 ${screens.length} 屏（上限 ${maxScreens}），停止原因：${stoppedBecause}`,
      ...(missed.length ? ["没能走进去的地方：", ...missed.map((m) => `- ${m}`)] : []),
      "这份材料只覆盖上面列出的界面。没有出现在这里的功能，是没有被看到，不是不存在。",
    ].join("\n");

    return {
      notes: [...screens, coverage].join("\n\n"),
      url: spec.url,
      log,
      shotRef: await shot(session),
      screens: screens.length,
      stoppedBecause,
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
