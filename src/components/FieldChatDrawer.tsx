import { useCallback, useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { Drawer } from "@/components/overlay";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 把一个复杂字段**聊出来**。
 *
 * 规则包在这之前只有一条路：写一份 18 个顶层字段的 JSON，每条规则带 claimType /
 * sourceRefs / riskFloor / verification，再传上来。结果是这条路对新用户等于关着——
 * 2026-09-15 拿 Vikunja 跑通用性时撞到的正是这个：没规则包 → 没产品模型 →
 * 工作单元循环用不了，于是降级路径成了默认路径。
 *
 * 这个抽屉是那件事的另一半。它刻意长成 `DiagnoseDrawer` 的样子，也刻意守着同两条规矩：
 *
 * - **附着在字段上**，点那个字段才打开，不是一条常驻的对话栏。这个产品不靠聊天驱动。
 * - **它只起草，不保存。** 底部那个按钮把值交回打开它的那一页，由那一页走它本来就有的
 *   保存路径（规则包走 `POST .../rule-packs`，服务端 `validateRulePack` 在那儿等着）。
 *   多开一条「聊天专用的保存」就多一份会和主路径走岔的校验。
 *
 * 界面上最要紧的一块不是对话，是**顶上那个选运行的下拉**：起草的证据全部来自那次运行的
 * 探索材料。选了一次没有材料的运行，模型能产出的只有一份读起来完整、每条都无从核对的东西
 * ——所以每一行都标着「几份材料 / 模块树冻没冻」，让人选之前就看得见。
 */
interface Turn {
  role: "you" | "bot" | "sys";
  text: string;
}

type RunRow = { runId: string; at?: string; status?: string; materials: number; modules: number };
type Draft = { kind: string; value: unknown; valid: boolean; issues: string[]; warnings?: string[]; target?: string };

export function FieldChatDrawer({
  field,
  title,
  projectId,
  runId: fixedRunId,
  onApply,
  onClose,
}: {
  field: "rulePack" | "domainKnowledge";
  /** 抽屉标题里那个字段名。给了就用给的——页面比这里更清楚它把这个字段叫什么。 */
  title?: string;
  projectId: string;
  /** 已经在某次运行的上下文里打开时，就别再让人选一次。 */
  runId?: string;
  /** 交回字段的值。返回的字符串当作保存失败的理由显示出来。 */
  onApply: (value: unknown) => void | Promise<string | void>;
  onClose: () => void;
}) {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runId, setRunId] = useState(fixedRunId ?? "");
  const [draft, setDraft] = useState<Draft>();
  const [applyError, setApplyError] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (fixedRunId) return;
    const c = new AbortController();
    void fetch(`${API_BASE}/api/chat/fields?projectId=${encodeURIComponent(projectId)}`, { signal: c.signal })
      .then((r) => r.json())
      .then((d: { runs?: RunRow[] }) => {
        const rows = d.runs ?? [];
        setRuns(rows);
        // 默认选**手里有材料的最近一次**——最近一次运行未必采到过东西。
        setRunId((cur) => cur || rows.find((r) => r.materials > 0)?.runId || "");
      })
      .catch(() => {});
    return () => c.abort();
  }, [projectId, fixedRunId]);

  // 花括号不是风格问题：箭头函数的隐式返回会把 scrollIntoView 的返回值当成清理函数交给 React，
  // 而 React 拿到一个不是函数的东西就会在卸载时 `destroy is not a function` 整棵树炸掉。
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns, busy, draft]);

  const send = useCallback(
    async (text: string) => {
      const said = text.trim();
      if (!said || busy) return;
      const next = [...turns, { role: "you" as const, text: said }];
      setTurns(next);
      setInput("");
      setBusy(true);
      setApplyError("");
      try {
        const res = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intent: "field",
            field,
            projectId,
            // 材料由网关自己去账本里读。页面不替模型准备证据——它准备得了的只有它正在显示的那点。
            ...(runId ? { context: { kind: "run", wfRunId: runId } } : {}),
            // 上一版原样带回去：这一轮是改它。不带的话，实测是改一个枚举值顺手丢掉三个功能。
            ...(draft ? { previous: draft.value } : {}),
            messages: next
              .filter((m) => m.role !== "sys")
              .map((m) => ({ role: m.role === "you" ? "user" : "assistant", text: m.text })),
          }),
        });
        const body = (await res.json()) as { reply?: string; draft?: Draft; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setTurns([...next, { role: "bot", text: body.reply ?? "" }]);
        // 这一轮没给值就是一次提问，上一版草稿留着——不要让追问把已经聊出来的东西清空。
        if (body.draft) setDraft(body.draft);
      } catch (e) {
        setTurns([...next, { role: "sys", text: (e as Error).message }]);
      } finally {
        setBusy(false);
      }
    },
    [busy, draft, field, projectId, runId, turns],
  );

  /**
   * 校验没过的理由，**原样喂回对话**。
   *
   * 这是这个设计里唯一让它比「让人自己写 JSON」强的地方：`validateRulePack` 说的是
   * 「/rules/3/sourceRefs/0：引用了不存在的来源」，模型照着改就行，人只看改了什么。
   */
  const fix = () => void send(t("field.fixPrompt", { errors: (draft?.issues ?? []).slice(0, 12).join("\n") }));

  const apply = async () => {
    if (!draft?.valid) return;
    setBusy(true);
    try {
      const failed = await onApply(draft.value);
      if (failed) setApplyError(failed);
      else onClose();
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = runs.find((r) => r.runId === runId);

  return (
    <Drawer
      open
      onClose={onClose}
      resizeKey="field-chat"
      defaultWidth={560}
      title={
        <span className="flex items-center gap-1.5">
          <MessagesSquare className="h-4 w-4 text-primary" />
          {t("field.draft", { field: title ?? field })}
        </span>
      }
    >
      <p className="border-b border-border px-4 py-2 text-[0.75rem] leading-relaxed text-muted-foreground">
        {t("field.rule")}
      </p>

      {!fixedRunId && (
        <label className="flex flex-col gap-1 border-b border-border px-4 py-2 text-[0.75rem]">
          <span className="text-muted-foreground">{t("field.evidence")}</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-[0.8125rem]"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
          >
            <option value="">{t("field.noRun")}</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.runId.slice(0, 12)} · {r.at ? new Date(r.at).toLocaleString() : "?"} ·{" "}
                {t("field.runCounts", { m: r.materials, k: r.modules })}
              </option>
            ))}
          </select>
          {/* 选了一次没有材料的运行，和没选运行是同一回事——说出来，而不是让它悄悄起草。 */}
          {runId && chosen && chosen.materials === 0 && <span className="text-warn">{t("field.runEmpty")}</span>}
          {!runId && <span className="text-warn">{t("field.noRunWarn")}</span>}
        </label>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {turns.length === 0 && (
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{t(`field.hint.${field}`)}</p>
        )}
        <div className="space-y-2">
          {turns.map((m, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[0.8125rem] leading-relaxed",
                m.role === "you" ? "bg-primary/10" : m.role === "sys" ? "font-mono text-[0.75rem] text-bad" : "bg-muted",
              )}
            >
              {m.text}
            </div>
          ))}
          {busy && <div className="text-[0.75rem] text-muted-foreground">{t("wf.chatThinking")}</div>}
          <div ref={end} />
        </div>
      </div>

      {draft && (
        <div className="max-h-[38vh] overflow-auto border-t border-border p-3">
          <div className="mb-2 flex items-center gap-2 text-[0.75rem]">
            <span className={draft.valid ? "text-ok" : "text-bad"}>
              {t(draft.valid ? "field.valid" : "field.invalid", { n: draft.issues.length })}
            </span>
            {!draft.valid && (
              <Button size="sm" disabled={busy} onClick={fix}>
                {t("field.fix")}
              </Button>
            )}
          </div>
          {/* 上一版有而这一版没有的东西。不拦——正经的修改本来就会删——但绝不闷着。 */}
          {!!draft.warnings?.length && (
            <ul className="mb-2 space-y-0.5 text-[0.6875rem] text-warn">
              {draft.warnings.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
          {/* 拒收理由一条不省。概括成「有 3 个问题」，模型下一轮就没有东西可改。 */}
          {!!draft.issues.length && (
            <ul className="mb-2 space-y-0.5 font-mono text-[0.6875rem] text-bad">
              {draft.issues.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-2 text-[0.6875rem]">
            {typeof draft.value === "string" ? draft.value : JSON.stringify(draft.value, null, 2)}
          </pre>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border p-2">
        {applyError && (
          <p role="alert" className="break-words text-[0.75rem] text-bad">
            {applyError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="h-16 min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-[0.8125rem]"
            value={input}
            placeholder={t("field.placeholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(input);
            }}
          />
          <div className="flex flex-col gap-1">
            <Button variant="primary" disabled={busy || !input.trim()} onClick={() => void send(input)}>
              {t("wf.chatSend")}
            </Button>
            <Button disabled={busy || !draft?.valid} onClick={() => void apply()}>
              {t("field.apply")}
            </Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
