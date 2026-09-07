import { useEffect, useRef, useState } from "react";
import { Stethoscope } from "lucide-react";
import { Drawer } from "@/components/overlay";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 诊断：问一个关于**眼前这个东西**的问题。
 *
 * 这里以前是画布左侧一条常驻 340px 的对话栏，里面有四种模式——问问题 / 改这张图 /
 * 改提示词 / 起草能力 recipe——由一个下拉框选。三个问题叠在一起：
 *
 * - 后三种在「能力」页里已经有完整的一份，画布上那份是复制品；
 * - 下拉框要求人在打字之前先替模型做一次分类，选错不会报错，只会得到一个语气正确
 *   但没有草稿的回答；
 * - 而一条永远在那里的对话栏，是在宣告这个产品主要靠聊天驱动——它不是，也不该是。
 *   流程固定是这个项目的核心设计：一条每次都不一样地启动的流水线没法和自己比较，
 *   而「能和自己比较」正是评测层存在的全部理由。
 *
 * 所以只剩下真正需要模型的那一件事：跨产物的推理。「门禁①给了 58%，差在哪」这个答案
 * 不在任何一张表里，要同时读规格、故事、用例和 finding 才能给。它按需打开，
 * **附着在它解释的那个对象上**，而不是漂在一条独立的列里。
 *
 * 追问是保留的：有上文的追问是真需求，无上文的空对话框不是。
 */
interface Turn {
  role: "you" | "bot" | "sys";
  text: string;
}

export interface DiagnoseScope {
  kind: "node" | "run";
  node?: string;
  wfRunId?: string;
}

export function DiagnoseDrawer({ scope, onClose }: { scope: DiagnoseScope; onClose: () => void }) {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // 换一个对象就是换一个问题：把上一个对象的对话留着，会让追问带上不属于它的上文。
  useEffect(() => setTurns([]), [scope.kind, scope.node, scope.wfRunId]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [turns, busy]);

  const ask = async (text: string) => {
    const said = text.trim();
    if (!said || busy) return;
    const next = [...turns, { role: "you" as const, text: said }];
    setTurns(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "ask",
          messages: next
            .filter((m) => m.role !== "sys")
            .map((m) => ({ role: m.role === "you" ? "user" : "assistant", text: m.text })),
          // 网关自己去读这个节点的参数、花费和产物——页面不替模型准备数字。
          context: scope,
        }),
      });
      const body = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTurns([...next, { role: "bot", text: body.reply ?? "" }]);
    } catch (e) {
      setTurns([...next, { role: "sys", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const subject = scope.node || scope.wfRunId || "";
  const tips =
    scope.kind === "node"
      ? ["wf.tipNode1", "wf.tipNode2", "wf.tipNode3"]
      : ["wf.tipRun1", "wf.tipRun2", "wf.tipRun3"];

  return (
    <Drawer
      open
      onClose={onClose}
      resizeKey="diagnose"
      defaultWidth={520}
      title={
        <span className="flex items-center gap-1.5">
          <Stethoscope className="h-4 w-4 text-primary" />
          {t("wf.diagnose")}
          <span className="font-mono text-[0.75rem] text-muted-foreground">{subject}</span>
        </span>
      }
    >
      {/* 这条规则此前只活在一个 title 属性里，要 hover 才看得到——而它是整个设计里
          最重要的约束：跑什么、什么时候跑，由画布上的按钮决定，不由一句话决定。 */}
      <p className="border-b border-border px-4 py-2 text-[0.75rem] leading-relaxed text-muted-foreground">
        {t("wf.diagnoseRule")}
      </p>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {turns.length === 0 && (
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{t("wf.diagnoseHint")}</p>
        )}
        <div className="space-y-2">
          {turns.map((m, i) => (
            <div
              key={i}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-[0.8125rem] leading-relaxed",
                m.role === "you"
                  ? "bg-primary/10"
                  : m.role === "sys"
                    ? "font-mono text-[0.75rem] text-bad"
                    : "bg-muted",
              )}
            >
              {m.text}
            </div>
          ))}
          {busy && <div className="text-[0.75rem] text-muted-foreground">{t("wf.chatThinking")}</div>}
          <div ref={end} />
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border p-2">
        {/* 问得动的问题，跟着眼前这个对象变。不是功能的快捷方式。 */}
        {turns.length === 0 && (
          <div className="flex flex-wrap gap-1">
            {tips.map((k) => (
              <button
                key={k}
                onClick={() => void ask(t(k))}
                className="cursor-pointer rounded-full border border-border px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t(k)}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="h-16 min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-[0.8125rem]"
            value={input}
            placeholder={t("wf.diagnosePlaceholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask(input);
            }}
          />
          <Button variant="primary" disabled={busy || !input.trim()} onClick={() => void ask(input)}>
            {t("wf.chatSend")}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
