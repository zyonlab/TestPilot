/**
 * Context budgeting.
 *
 * The local model gets slower as the prompt grows, and a long document does not fit at all.
 * The naive fix — truncate the tail — silently drops whatever happened to be last, which is
 * usually the part a node most needed.
 *
 * So budgeting is explicit: a node says how much of the window each part of its material is
 * worth, and what gets dropped is a decision that can be read and reported rather than an
 * accident of ordering.
 */

/**
 * Tokens, estimated. Deliberately approximate: an exact count needs the tokenizer, and the
 * budget only has to be right enough to keep the request inside the window.
 * CJK text is roughly one token per character; Latin text is roughly one per four.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export interface BudgetPart {
  name: string;
  text: string;
  /** Share of the budget this part may claim, before any redistribution. */
  share: number;
  /** A part that must not be trimmed at all (a schema, an instruction). */
  fixed?: boolean;
}

export interface BudgetedPart {
  name: string;
  text: string;
  tokens: number;
  /** How much was cut, in tokens. Reported so a shrunken prompt is visible, not silent. */
  dropped: number;
}

export interface BudgetResult {
  parts: BudgetedPart[];
  total: number;
  limit: number;
  /** Total tokens removed across all parts. */
  dropped: number;
  /** True when nothing had to be cut. */
  fits: boolean;
}

/**
 * Fit the parts into a token budget.
 *
 * Two rules that matter more than the arithmetic:
 *
 *   **Unused share is redistributed.** A part that comes in under its allowance hands the
 *   remainder to the parts that are over. Without this, a fixed split wastes most of the
 *   window on material that does not need it — which is the same as making the window
 *   smaller for everyone else.
 *
 *   **A trimmed part keeps its head and its tail.** The middle is what gets removed, with a
 *   marker, because the beginning of a document says what it is and the end usually holds
 *   the part that was just appended.
 */
export function fitToBudget(parts: BudgetPart[], limit: number): BudgetResult {
  const sized = parts.map((p) => ({ ...p, tokens: estimateTokens(p.text) }));
  const totalShare = sized.reduce((n, p) => n + (p.fixed ? 0 : p.share), 0) || 1;
  const fixedTokens = sized.filter((p) => p.fixed).reduce((n, p) => n + p.tokens, 0);
  const flexible = Math.max(0, limit - fixedTokens);

  // First pass: what each flexible part is entitled to, and who is under it.
  const allowance = new Map<string, number>();
  for (const p of sized)
    allowance.set(p.name, p.fixed ? p.tokens : Math.floor((flexible * p.share) / totalShare));

  let spare = 0;
  const over: typeof sized = [];
  for (const p of sized) {
    const a = allowance.get(p.name)!;
    if (p.fixed) continue;
    if (p.tokens <= a) spare += a - p.tokens;
    else over.push(p);
  }
  // Second pass: hand the spare to whoever is over, in proportion to how much they want.
  const wanted = over.reduce((n, p) => n + (p.tokens - allowance.get(p.name)!), 0);
  for (const p of over) {
    const extra = wanted ? Math.floor((spare * (p.tokens - allowance.get(p.name)!)) / wanted) : 0;
    allowance.set(p.name, allowance.get(p.name)! + extra);
  }

  const out: BudgetedPart[] = sized.map((p) => {
    const a = allowance.get(p.name)!;
    if (p.tokens <= a) return { name: p.name, text: p.text, tokens: p.tokens, dropped: 0 };
    const text = trimMiddle(p.text, a);
    const tokens = estimateTokens(text);
    return { name: p.name, text, tokens, dropped: p.tokens - tokens };
  });

  const total = out.reduce((n, p) => n + p.tokens, 0);
  return { parts: out, total, limit, dropped: out.reduce((n, p) => n + p.dropped, 0), fits: total <= limit };
}

/** Keep the head and the tail, say what was removed in between. */
export function trimMiddle(text: string, tokenBudget: number): string {
  if (estimateTokens(text) <= tokenBudget) return text;
  const marker = "\n…[trimmed to fit the context budget]…\n";
  const budget = Math.max(0, tokenBudget - estimateTokens(marker));
  // Characters per token differs by script; derive it from this text rather than guessing.
  const perToken = text.length / Math.max(1, estimateTokens(text));
  const keep = Math.max(0, Math.floor(budget * perToken));
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}
