import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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
  widthClass = "w-[620px] max-w-[92vw]",
  resizeKey,
  defaultWidth = 880,
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
  /** Sibling views of the same object, shown as tabs beside the title. */
  tabs?: Array<{ id: string; label: string; active: boolean; onSelect: () => void }>;
  children: React.ReactNode;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (resizeKey ? widths.get(resizeKey) ?? defaultWidth : 0));
  const drag = useRef<{ x: number; w: number } | null>(null);
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
      const next = Math.max(420, Math.min(window.innerWidth - 80, drag.current.w + (drag.current.x - e.clientX)));
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
            <h2 className="min-w-0 truncate font-display text-sm font-medium text-foreground">
              {title}
            </h2>
          )}
          {tabs && (
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {tabs.map((tb) => (
                <button
                  key={tb.id}
                  onClick={tb.onSelect}
                  className={cn(
                    "flex-none cursor-pointer rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
                    tb.active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {tb.label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className={cn(
              "ml-auto cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
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
              "ml-auto cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
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
