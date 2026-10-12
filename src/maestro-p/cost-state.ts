// claude's own cost tracker, read off the transcript.
//
// The interactive TUI writes a `cost-state` row to the session transcript when
// it exits. It is the same tracker `claude -p` reports from: its `modelUsage`
// and `totalCostUSD` are what a `--print` run puts in its result envelope as
// `modelUsage` and `total_cost_usd`. It covers every model the turn touched,
// including the side calls (title generation, web search, subagents) that never
// appear as main-thread assistant rows.
//
// Both numbers are SESSION totals, not this turn's: claude restores the tracker
// on `--resume`, and `claude -p --resume` reports the restored running total
// (measured: a second turn reported 0.1454 where the first alone was 0.1299).
// maestro-p reports them the same way, so a caller sees what `claude -p` shows.

import { getModelContextWindowOverride } from '../shared/agentConstants';

/** One model's entry in a result envelope's `modelUsage`, in `claude -p`'s shape. */
export interface ModelUsageEntry {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	webSearchRequests: number;
	costUSD: number;
	thinkingTokens?: number;
	/** Only when the model id names its window (`[1m]`); the tracker does not record it. */
	contextWindow?: number;
}

export interface CostState {
	totalCostUSD: number;
	modelUsage: Record<string, ModelUsageEntry>;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The tracker carried by a transcript row, or null when the row is not a `cost-state` row. */
export function parseCostStateRow(entry: unknown): CostState | null {
	if (!entry || typeof entry !== 'object') return null;
	const row = entry as Record<string, unknown>;
	if (row.type !== 'cost-state') return null;
	const modelUsage: Record<string, ModelUsageEntry> = {};
	const raw = row.modelUsage;
	if (raw && typeof raw === 'object') {
		for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') continue;
			const stats = value as Record<string, unknown>;
			const entry: ModelUsageEntry = {
				inputTokens: num(stats.inputTokens),
				outputTokens: num(stats.outputTokens),
				cacheReadInputTokens: num(stats.cacheReadInputTokens),
				cacheCreationInputTokens: num(stats.cacheCreationInputTokens),
				webSearchRequests: num(stats.webSearchRequests),
				costUSD: num(stats.costUSD),
			};
			if (typeof stats.thinkingTokens === 'number') entry.thinkingTokens = stats.thinkingTokens;
			modelUsage[model] = withContextWindow(model, entry);
		}
	}
	return { totalCostUSD: num(row.totalCostUSD), modelUsage };
}

/**
 * Add the context window a model id implies. `claude -p` reports a window per
 * model, but the tracker the TUI writes does not, and the only window the id
 * itself proves is the `[1m]` extended one. Anything else is left unset rather
 * than guessed: a wrong window is worse than none, because the caller then
 * trusts it over its own configured value.
 */
export function withContextWindow(model: string, entry: ModelUsageEntry): ModelUsageEntry {
	const window = getModelContextWindowOverride(model);
	return window === null ? entry : { ...entry, contextWindow: window };
}
