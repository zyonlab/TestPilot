import { createContext, useContext, useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A page made of sections instead of a wall of cards.
 *
 * 资产、运行、设置 each hold several unrelated things — a list of executions is not a
 * baseline is not a language preference. Laid out flat they read as one pile, so the left
 * rail names them and only one is on screen at a time.
 *
 * Existing pages are hosted here unchanged. They each render their own `<TopBar>`, which
 * would stack two headers inside a section, so the host publishes a flag and the top bar
 * steps aside — cheaper and far less risky than restructuring twelve files, and the pages
 * keep working standalone.
 */
const InSection = createContext(false);
export const useInSection = (): boolean => useContext(InSection);
/** Host a page inside something that already has a header (a section, or a surface card). */
export const InSectionProvider = ({ children }: { children: React.ReactNode }) => (
  <InSection.Provider value={true}>{children}</InSection.Provider>
);

export interface Section {
  id: string;
  label: string;
  /** Why this section exists, in one line. Shown beside the heading, not as a tooltip. */
  why?: string;
  group?: string;
  /** Hidden sections stay out of the rail — e.g. chain config when the target is not web. */
  hidden?: boolean;
  render: () => React.ReactNode;
}

/**
 * The active section lives in the URL (`#/history?s=baselines`), so "the baselines waiting
 * for review" is a link someone can send.
 */
export function useSectionParam(fallback: string): [string, (id: string) => void] {
  const read = () =>
    new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("s") ?? fallback;
  const [id, setId] = useState(read);
  useEffect(() => {
    const onHash = () => setId(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (next: string) => {
    const [path] = window.location.hash.split("?");
    window.location.hash = `${path}?s=${next}`;
    setId(next);
  };
  return [id, set];
}

export function SectionPage({
  title,
  subtitle,
  sections,
  fallback,
  compact = false,
}: {
  title: string;
  subtitle: string;
  sections: Section[];
  fallback: string;
  /** Inside a drawer the title is already on the drawer's own header. */
  compact?: boolean;
}) {
  const shown = sections.filter((s) => !s.hidden);
  const [active, setActive] = useSectionParam(fallback);
  const current = shown.find((s) => s.id === active) ?? shown[0];

  let group: string | undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!compact && (
        <div className="border-b border-border px-4 py-3">
          <h1 className="font-display text-[17px] font-medium text-foreground">{title}</h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">{subtitle}</p>
        </div>
      )}

      <div className="grid min-h-0 flex-1 md:grid-cols-[176px_minmax(0,1fr)]">
        <nav className="flex flex-col gap-0.5 overflow-auto border-r border-border p-2">
          {shown.map((s) => {
            const head = s.group && s.group !== group ? s.group : null;
            group = s.group;
            return (
              <div key={s.id}>
                {head && (
                  <div className="px-2.5 pb-1 pt-2.5 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
                    {head}
                  </div>
                )}
                <button
                  onClick={() => setActive(s.id)}
                  className={cn(
                    "w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                    s.id === current?.id
                      ? "bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {s.label}
                </button>
              </div>
            );
          })}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-col">
          {current?.why && (
            <div className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
              {current.why}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <InSection.Provider value={true}>{current?.render()}</InSection.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
