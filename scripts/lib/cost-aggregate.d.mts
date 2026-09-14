export interface CostRow {
  id: string; caseId: string; caseTitle: string; priority: string; status: string; durationMs: number; startedAt: string;
  tokens?: number | null; spendJson?: string | null; oracleJson?: string | null; infraError?: number | boolean | null; failKind?: string | null; healed?: number | boolean | null; attempts?: number | null;
}
export interface CostReport { cases: Array<Record<string, unknown>>; totals: Record<string, unknown> }
export function aggregate(rows: CostRow[], degrades: Array<Record<string, unknown>>, opts?: { last?: number; usdPerMtok?: number }): CostReport;
export const PHASES: string[];
export const PHASE_LABEL: Record<string, string>;
export function median(xs: number[]): number | undefined;
export function spread(xs: number[]): string;
export function fmtMs(ms?: number): string;
