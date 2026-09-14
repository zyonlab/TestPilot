import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "@/lib/prefs";
import { hasKey } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { ArtifactFinding, CaseField } from "./types";

/**
 * 门禁的 finding，画成人话。
 *
 * 此前界面直接显示 `[oracle-vague] assertion names no observable phenomenon:"到达 /owners/find 页面"`
 * ——一个中文界面里的英文 lint 码，没有解释、没有改法、点不动。根因不在前端：
 * 那句话在 `casegen/gate.ts` 里就被拼死了，过河即成常量，没有 key 也就没法译。
 *
 * 新格式只带 `rule` + `args` + `field`，句子在这里按 i18n key 组装：
 *   gate.<rule>.msg   这条在说什么（可带 {占位符}）
 *   gate.<rule>.why   这条规则在管什么
 *   gate.<rule>.fix   改成什么样就过
 * 存量数据只有 `message` 字符串，照原样显示并打上「旧格式」，不做迁移——
 * 评测历史不该被改写。
 */
export function Findings({
  findings,
  onFocusField,
  prefix,
}: {
  findings: ArtifactFinding[];
  /** 点一条 finding 时把光标送到它挑毛病的那个字段。 */
  onFocusField?: (field: CaseField) => void;
  /** 「改过之后仍然」这类前缀。 */
  prefix?: string;
}) {
  if (!findings.length) return null;
  return (
    <ul className="space-y-1">
      {findings.map((f, i) => (
        <FindingRow key={`${f.rule}-${i}`} f={f} onFocusField={onFocusField} prefix={prefix} />
      ))}
    </ul>
  );
}

/** 这条模板里还有没有没填上的洞。有洞而没参数，就说明这是一条旧格式的 finding。 */
function templateHasHoles(key: string, t: (k: string) => string): boolean {
  return /\{\w+\}/.test(t(key));
}

function FindingRow({
  f,
  onFocusField,
  prefix,
}: {
  f: ArtifactFinding;
  onFocusField?: (field: CaseField) => void;
  prefix?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const msgKey = `gate.${f.rule}.msg`;
  const whyKey = `gate.${f.rule}.why`;
  const fixKey = `gate.${f.rule}.fix`;
  /**
   * 只有**带了 args** 的 finding 才走翻译。
   *
   * 存量 finding 只有一句拼死的英文，没有参数——拿它去填 `{expected}` 这样的洞，
   * 界面上会原样印出一个花括号。宁可显示旧的英文原文，也不显示一个漏填的模板：
   * 前者至少是真话。
   */
  const translated = hasKey(msgKey) && (f.args !== undefined || !templateHasHoles(msgKey, t));
  const text = translated ? t(msgKey, f.args ?? {}) : (f.message ?? t(msgKey));
  const explainable = hasKey(whyKey) || hasKey(fixKey);
  const tone =
    f.severity === "block" ? "text-bad" : f.severity === "warn" ? "text-warn" : "text-muted-foreground";

  return (
    <li className="text-[0.75rem] leading-[1.6]">
      <div className="flex items-start gap-1.5">
        <span
          className={cn(
            "mt-[0.1875rem] h-1.5 w-1.5 shrink-0 rounded-full",
            f.severity === "block" ? "bg-bad" : f.severity === "warn" ? "bg-warn" : "bg-muted-foreground/50",
          )}
          aria-hidden
        />
        <button
          type="button"
          className={cn("min-w-0 flex-1 text-left", tone, explainable && "hover:underline")}
          onClick={() => explainable && setOpen((v) => !v)}
        >
          {prefix ? `${prefix} ` : ""}
          {text}
          {!translated && <span className="ml-1 font-mono text-[0.6875rem] opacity-60">[{f.rule}]</span>}
          {explainable &&
            (open ? (
              <ChevronDown className="ml-1 inline h-3 w-3 align-[-1px]" />
            ) : (
              <ChevronRight className="ml-1 inline h-3 w-3 align-[-1px]" />
            ))}
        </button>
        {f.field && onFocusField && (
          <button
            type="button"
            className="shrink-0 font-mono text-[0.6875rem] text-primary hover:underline"
            onClick={() => onFocusField(f.field!)}
          >
            {t("gate.goFix")}
          </button>
        )}
      </div>
      {open && (
        <div className="ml-3 mt-1 space-y-0.5 border-l border-border pl-2.5 text-[0.6875rem] text-muted-foreground">
          {hasKey(whyKey) && <div>{t(whyKey)}</div>}
          {hasKey(fixKey) && (
            <div className="text-foreground">
              {t("gate.fixLabel")} {t(fixKey)}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
