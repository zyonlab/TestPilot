import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/prefs";

// Locks body scroll while at least one overlay is open (ref-counted so nested
// overlays don't clobber each other's restore).
let scrollLocks = 0;
function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    scrollLocks += 1;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = prev;
    };
  }, [active]);
}

// Escape-to-close, shared by both primitives.
function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);
}

/**
 * How wide the reader last dragged a drawer, kept per drawer kind.
 *
 * A drawer holding a specification and a drawer holding one run's detail want different
 * widths, and re-dragging on every open is the kind of small tax that makes a reader stop
 * opening things. Held in memory rather than storage: it is a working preference, not a
 * setting, and it should not outlive the session in a way nobody asked for.
 */
const widths = new Map<string, number>();

/**
 * 展开到最宽时能占到哪。
 *
 * 原来一律留 80px 的缝「好让人记得自己是从哪儿进来的」。但从 Flow 点开的节点抽屉里放的是
 * 物料正文——规格、故事、用例表、执行报告，那条缝换来的是正文被挤窄。
 * 2026-09-11 用户明确要它整屏。所以按用途分：`fullscreen` 的抽屉占满，其余保留那条缝。
 */
const wideOf = (full = false): number => (full ? window.innerWidth : Math.max(420, window.innerWidth - 80));

/**
 * 没拖过时该多宽。
 *
 * 原来是一个固定的 980：在 1440 的屏上偏窄（故事图四列要横向滚、
 * 用例标题被截断），在 2560 的屏上又浪费。跟着视口走，两头都合理。
 */
const roomyDefault = (fallback: number): number =>
  Math.min(wideOf(), Math.max(fallback, Math.round(window.innerWidth * 0.72)));

/**
 * Right-side slide-over. Header row with an optional title + close (X) button;
 * the content area scrolls. Backdrop dims and closes on click. Escape closes,
 * body scroll is locked while open, and the panel is focused on open. The
 * translate-x transition is skipped when the user prefers reduced motion.
 *
 * **Width is the reader's call.** These drawers hold specifications, tables and code
 * diffs — material whose comfortable width depends on what is in it, not on what looked
 * balanced when the component was written. Drag the left edge; `resizeKey` decides what
 * that width is remembered against.
 */
export function Drawer({
  open,
  onClose,
  title,
  widthClass = "w-[38.75rem] max-w-[92vw]",
  resizeKey,
  defaultWidth = 880,
  fullscreen = false,
  tabs,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  widthClass?: string;
  /** Enables dragging, and names the bucket the chosen width is remembered in. */
  resizeKey?: string;
  defaultWidth?: number;
  /**
   * 默认整屏打开（仍可拖窄，标题栏的收合按钮在整屏与常规宽度之间来回）。
   * 给的是**放正文**的抽屉：节点物料、执行报告、规格。
   */
  fullscreen?: boolean;
  /** Sibling views of the same object, shown as tabs beside the title. */
  tabs?: Array<{ id: string; label: string; active: boolean; onSelect: () => void }>;
  children: React.ReactNode;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() =>
    resizeKey ? (widths.get(resizeKey) ?? (fullscreen ? wideOf(true) : roomyDefault(defaultWidth))) : 0,
  );
  const drag = useRef<{ x: number; w: number } | null>(null);
  /**
   * 展开之前那一档宽度。
   *
   * 展开是个**开关**，不是一次单程操作：人点开它看一眼宽的，然后要能回到原来那档。
   * 只提供「变宽」而不提供「回去」，等于逼人重新拖一次那条 1.5px 的边。
   */
  const restoreTo = useRef<number | null>(null);
  const wide = resizeKey ? width >= wideOf(fullscreen) - 4 : false;
  const toggleWide = () => {
    if (!resizeKey) return;
    const next = wide ? (restoreTo.current ?? roomyDefault(defaultWidth)) : wideOf(fullscreen);
    if (!wide) restoreTo.current = width;
    setWidth(next);
    widths.set(resizeKey, next);
  };
  useBodyScrollLock(open);
  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!resizeKey) return;
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      // Clamped so the drawer can never be dragged past being unusable in either direction:
      // a 40px sliver and a drawer that hides the canvas it came from are both dead ends.
      const next = Math.max(
        420,
        Math.min(wideOf(fullscreen), drag.current.w + (drag.current.x - e.clientX)),
      );
      setWidth(next);
      widths.set(resizeKey, next);
    };
    const up = () => {
      drag.current = null;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [resizeKey]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* scrim */}
      <div
        className="absolute inset-0 bg-black/25 motion-safe:transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={resizeKey ? { width } : undefined}
        className={cn(
        /* `outline-none` 在这里是对的，别加焦点环：这是抽屉/对话框的**容器**，
           `tabIndex={-1}` 只为打开时把焦点程序化地放进来，人不会 Tab 到它上面。
           给容器画一圈环，等于每次开抽屉都闪一下。里面真正的控件各自有环。 */
          "absolute right-0 top-0 flex h-full flex-col border-l border-border bg-card shadow-xl outline-none",
          "motion-safe:translate-x-0 motion-safe:transition-transform motion-safe:duration-300",
          !resizeKey && widthClass,
        )}
      >
        {resizeKey && (
          <div
            onMouseDown={(e) => {
              drag.current = { x: e.clientX, w: panelRef.current?.getBoundingClientRect().width ?? width };
              document.body.style.userSelect = "none";
              e.preventDefault();
            }}
            title={t("overlay.dragWidth")}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30"
          />
        )}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {title != null && (
            <h2 className="min-w-0 truncate font-display text-sm font-medium text-foreground">{title}</h2>
          )}
          {tabs && (
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {tabs.map((tb) => (
                <button
                  key={tb.id}
                  onClick={tb.onSelect}
                  className={cn(
                    "flex-none cursor-pointer rounded-md px-2.5 py-1 text-[0.8125rem] transition-colors",
                    tb.active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {tb.label}
                </button>
              ))}
            </div>
          )}
          {/*
            拖那条 1.5px 的边是**发现不了**的交互：它没有可见的样子，
            也没人会去试。放一个明确的开关在标题栏里——故事图和产品地图
            都是「宽一点就好读很多」的东西，而这一下应当只花一次点击。
          */}
          {resizeKey && (
            <button
              onClick={toggleWide}
              title={t(wide ? "overlay.narrow" : "overlay.widen")}
              aria-label={t(wide ? "overlay.narrow" : "overlay.widen")}
              className={cn(
                "ml-auto cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              {wide ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label={t("overlay.close")}
            className={cn(
              "cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              !resizeKey && "ml-auto",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Centered modal card (max-w-md). Backdrop, close button, Escape-to-close,
 * body scroll lock, focus-on-open. A lightly-used but general primitive.
 */
export function Dialog({
  open,
  onClose,
  title,
  widthClass = "max-w-md",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  widthClass?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock(open);
  useEscapeToClose(open, onClose);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/25 motion-safe:transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
        /* `outline-none` 在这里是对的，别加焦点环：这是抽屉/对话框的**容器**，
           `tabIndex={-1}` 只为打开时把焦点程序化地放进来，人不会 Tab 到它上面。
           给容器画一圈环，等于每次开抽屉都闪一下。里面真正的控件各自有环。 */
          "relative flex max-h-[90vh] w-full flex-col rounded-xl border border-border bg-card shadow-xl outline-none",
          widthClass,
          "motion-safe:transition-transform motion-safe:duration-200",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {title != null && (
            <h2 className="min-w-0 flex-1 truncate font-display text-sm font-medium text-foreground">
              {title}
            </h2>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className={cn(
              "cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
