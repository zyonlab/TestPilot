/**
 * Which gateway this tab talks to.
 *
 * A constant until the harness had to test its own product: then two gateways run at once
 * — the one doing the testing and the one under test — and a page hard-wired to one of
 * them cannot be pointed at the other. `?api=http://127.0.0.1:5401` switches a tab over
 * and is remembered, so the self-test drives the instance it means to drive rather than
 * quietly rewriting the real one's database.
 *
 * Chosen once, at module load: a base URL that changed under a running page would leave
 * half its state belonging to one server and half to another.
 */
const DEFAULT_BASE = "http://localhost:5301";
const KEY = "tp.apiBase";

function resolveBase(): string {
  if (typeof window === "undefined") return DEFAULT_BASE;
  const asked = new URLSearchParams(window.location.search).get("api");
  if (asked) {
    try {
      const url = new URL(asked).origin;
      window.localStorage.setItem(KEY, url);
      return url;
    } catch {
      /* an unparseable override is ignored rather than breaking every request */
    }
  }
  return window.localStorage.getItem(KEY) ?? DEFAULT_BASE;
}

export const API_BASE = resolveBase();
export const WS_URL = `${API_BASE.replace(/^http/, "ws")}/ws`;
/** True when this tab is NOT looking at the default gateway — worth saying out loud. */
export const IS_OVERRIDDEN = API_BASE !== DEFAULT_BASE;

/**
 * Back to the usual gateway.
 *
 * The override is remembered, which is what makes it usable — and also what would strand
 * someone on the instance under test with no way back except a URL they no longer have.
 */
export function resetApiBase(): void {
  window.localStorage.removeItem(KEY);
  window.location.href = `${window.location.pathname}${window.location.hash}`;
}
