import type { Action, CodeCase, Fragment } from "./types.js";

/**
 * Reading generated code back into actions, and folding repeated prologues into fragments.
 *
 * The generator is asked for Midscene source, but the harness keeps the *meaning* rather
 * than trusting the text: what a run executes, what a gate inspects and what a repair loop
 * diffs all have to be the same thing, or the three disagree about what the case does.
 */

const CALL = /\bagent\s*\.\s*(aiAction|aiAssert|aiInput|aiQuery|aiTap|aiWaitFor)\s*\(/g;

/** Read a JS string literal (single, double or backtick) starting at `i`. */
function readString(src: string, i: number): { value: string; end: number } | undefined {
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let out = "";
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      const next = src[j + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      j++;
      continue;
    }
    if (ch === quote) return { value: out, end: j + 1 };
    out += ch;
  }
  return undefined;
}

export interface ParsedCode {
  actions: Action[];
  /** Calls that are not part of the allowed surface, kept for the gate to complain about. */
  unsupported: string[];
}

/**
 * Parse the allowed Midscene surface out of generated source.
 *
 * Deliberately not a JS evaluator: nothing here executes the model's output. What cannot
 * be read as one of the known calls is reported rather than ignored — silently dropping a
 * line would produce a case that runs something different from what it says.
 */
/** Driving the browser directly instead of through the agent: outside the surface. */
const FOREIGN = /\b(page|browser|driver|cy|element|context|frame)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

export function parseCode(code: string): ParsedCode {
  const actions: Action[] = [];
  const unsupported: string[] = [];

  FOREIGN.lastIndex = 0;
  let foreign: RegExpExecArray | null;
  while ((foreign = FOREIGN.exec(code)) !== null)
    unsupported.push(`${foreign[1]}.${foreign[2]}() is not part of the allowed surface`);

  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = CALL.exec(code)) !== null) {
    const method = m[1];
    let i = m.index + m[0].length;
    while (i < code.length && /\s/.test(code[i])) i++;
    const first = readString(code, i);
    if (!first) {
      unsupported.push(`${method}(…) — argument is not a plain string`);
      continue;
    }
    if (method === "aiAction" || method === "aiTap") actions.push({ kind: "action", text: first.value });
    else if (method === "aiAssert") actions.push({ kind: "assert", text: first.value });
    else if (method === "aiWaitFor") actions.push({ kind: "action", text: `wait until ${first.value}` });
    else if (method === "aiInput") {
      let j = first.end;
      while (j < code.length && /[\s,]/.test(code[j])) j++;
      const second = readString(code, j);
      actions.push({ kind: "input", text: first.value, field: second?.value });
    } else unsupported.push(`${method} is not part of the allowed surface`);
  }

  return { actions, unsupported };
}

/** `${env.X}` / `${secret.X}` references a case reads. */
export function parseParams(code: string): string[] {
  return [...new Set([...code.matchAll(/\$\{((?:env|secret)\.[A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();
}

const same = (a: Action, b: Action): boolean =>
  a.kind === b.kind && a.text === b.text && (a.field ?? "") === (b.field ?? "");

/**
 * Fold shared prologues into fragments.
 *
 * "Reusable" has to mean the shared steps are *referenced*, not copied — a suite where
 * every case repeats the login is a suite where changing the login means editing fifty
 * files. This finds the longest opening sequence that at least `minCases` cases agree on
 * and lifts it out; everything else stays where it is.
 */
export function extractFragments(
  cases: CodeCase[],
  opts: { minCases?: number; minActions?: number; name?: string } = {},
): { cases: CodeCase[]; fragments: Fragment[] } {
  const minCases = opts.minCases ?? 2;
  const minActions = opts.minActions ?? 2;
  if (cases.length < minCases) return { cases, fragments: [] };

  // Longest common opening sequence across the largest group of cases that share it.
  let best: { actions: Action[]; members: string[] } | undefined;
  for (const seed of cases) {
    for (let len = seed.actions.length; len >= minActions; len--) {
      const prefix = seed.actions.slice(0, len);
      if (prefix.some((a) => a.kind === "assert")) continue; // a shared prologue is setup, not verdict
      const members = cases
        .filter((c) => c.actions.length > len && prefix.every((a, i) => same(a, c.actions[i])))
        .map((c) => c.caseId);
      if (members.length >= minCases && (!best || len * members.length > best.actions.length * best.members.length))
        best = { actions: prefix, members };
      if (members.length >= minCases) break;
    }
  }
  if (!best) return { cases, fragments: [] };

  const name = opts.name ?? "sharedSetup";
  const fragment: Fragment = { name, actions: best.actions, usedBy: best.members };
  const rewritten = cases.map((c) =>
    best!.members.includes(c.caseId)
      ? { ...c, actions: c.actions.slice(best!.actions.length), uses: [...c.uses, name] }
      : c,
  );
  return { cases: rewritten, fragments: [fragment] };
}

/** What the executor runs: the fragments a case uses, then its own actions. */
export function expandActions(kase: CodeCase, fragments: Fragment[]): Action[] {
  const prologue = kase.uses.flatMap((name) => fragments.find((f) => f.name === name)?.actions ?? []);
  return [...prologue, ...kase.actions];
}

/**
 * Fold a freshly parsed action list back onto the fragments a case already used.
 *
 * The repair loop shows the model the case's *whole* source (prologue included — the model
 * has to see what actually runs), so what comes back includes the prologue again. Without
 * this, the case would execute its setup twice, and every repair round would be classified
 * as a structural change because the folded and unfolded lists never line up.
 */
export function refold(
  kase: CodeCase,
  fragments: Fragment[],
  actions: Action[],
): { actions: Action[]; uses: string[] } {
  let rest = actions;
  const uses: string[] = [];
  for (const name of kase.uses) {
    const fragment = fragments.find((f) => f.name === name);
    if (!fragment) continue;
    const starts = fragment.actions.every((a, i) => rest[i] && same(a, rest[i]));
    if (starts) {
      rest = rest.slice(fragment.actions.length);
      uses.push(name);
    }
    // If the fix no longer begins with the shared setup, the case has stopped using it —
    // saying so is better than silently prepending steps the code no longer contains.
  }
  return { actions: rest, uses };
}

/** Repeated action runs still duplicated across cases, after fragment extraction. */
export function duplicateRuns(cases: CodeCase[], minLen = 2): number {
  const seen = new Map<string, number>();
  for (const c of cases)
    for (let i = 0; i + minLen <= c.actions.length; i++) {
      const key = c.actions
        .slice(i, i + minLen)
        .map((a) => `${a.kind}:${a.text}`)
        .join("|");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  return [...seen.values()].filter((n) => n > 1).length;
}
