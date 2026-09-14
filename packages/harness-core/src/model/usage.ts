export interface ProviderTokenUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null }
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function normalizeUsage(value: unknown): ProviderTokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, any>;
  const result = { inputTokens: count(u.prompt_tokens ?? u.input_tokens), outputTokens: count(u.completion_tokens ?? u.output_tokens), totalTokens: count(u.total_tokens), cachedInputTokens: count(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens) };
  return Object.values(result).every(n => n === null) ? null : result;
}
/** Bounded response inspection; never retain model text in the ledger. */
export function usageReader(stream: boolean) {
  let buffer = '', overflow = false, usage: ProviderTokenUsage | null = null;
  const decoder = new TextDecoder();
  const inspect = (line: string) => { try { const parsed = JSON.parse(line); const next = normalizeUsage(parsed.usage); if (next) usage = next; } catch { /* Non-usage event. */ } };
  return {
    push(value: Uint8Array) {
      if (overflow) return;
      buffer += decoder.decode(value, { stream: true });
      if (stream) { const lines = buffer.split('\n'); buffer = lines.pop()!; for (const line of lines) if (line.startsWith('data:')) inspect(line.slice(5).trim()); }
      if (buffer.length > 4 * 1024 * 1024) { buffer = ''; overflow = true; }
    },
    finish() { if (!overflow) { buffer += decoder.decode(); if (stream) { if (buffer.startsWith('data:')) inspect(buffer.slice(5).trim()); } else inspect(buffer); } return usage; },
  };
}
