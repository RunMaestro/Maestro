/**
 * Per-turn token ledger.
 *
 * `Session.usageStats` and `AITab.usageStats` accumulate for the life of the
 * agent, so neither can be written into a per-turn stats row - doing that would
 * count turn 1's tokens again on turn 2, again on turn 3, and so on. The raw
 * `process.onUsage` events, on the other hand, ARE per-turn deltas.
 *
 * This is the small bucket between them: usage events accumulate here keyed by
 * the RAW process session id, and the exit listener drains the bucket when it
 * records the query. One turn in, one row out.
 *
 * The raw id is the right key precisely because it is not the agent id - a
 * forced-parallel turn (`{id}-ai-{tab}-fp-{ts}`) and a normal turn on the same
 * tab are different processes running at the same time, and collapsing them
 * onto the agent would hand one turn's tokens to whichever finished first.
 *
 * Module-level rather than a store: nothing renders from it, it is written on
 * a streaming hot path, and a subscription would re-render the app on every
 * usage chunk.
 *
 * Shared rather than renderer-only because group chat turns are spawned and
 * exited entirely in the MAIN process (see `group-chat-turn-metrics`), so both
 * processes need this same accumulation. Each process gets its own module
 * instance and therefore its own map - they track different sessions and never
 * need to agree on an entry.
 */

import type { UsageStats } from './types';

/** Accumulated deltas for one in-flight turn. */
export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	/** Number of usage events folded in. Zero-token events still count. */
	events: number;
}

/**
 * Hard cap on tracked turns.
 *
 * Every entry is normally drained by the matching exit event, but a process
 * that dies without one (a crash, a killed agent, a batch id the exit listener
 * skips) would otherwise leak an entry for the life of the app. When the cap is
 * hit the oldest insertion is dropped - Map preserves insertion order, and the
 * oldest tracked turn is the one least likely to still be running.
 */
const MAX_TRACKED_TURNS = 500;

const ledger = new Map<string, TurnUsage>();

/**
 * Fold one usage event into the turn's running total.
 *
 * Called for every `process.onUsage` event with the raw session id exactly as
 * the IPC layer delivered it - do NOT pass a parsed agent id, or concurrent
 * turns on the same agent will merge.
 */
export function recordTurnUsage(rawSessionId: string, usage: UsageStats): void {
	const existing = ledger.get(rawSessionId);
	if (existing) {
		existing.inputTokens += usage.inputTokens || 0;
		existing.outputTokens += usage.outputTokens || 0;
		existing.cacheReadTokens += usage.cacheReadInputTokens || 0;
		existing.cacheCreationTokens += usage.cacheCreationInputTokens || 0;
		existing.costUsd += usage.totalCostUsd || 0;
		existing.events += 1;
		return;
	}

	if (ledger.size >= MAX_TRACKED_TURNS) {
		const oldest = ledger.keys().next();
		if (!oldest.done) ledger.delete(oldest.value);
	}

	ledger.set(rawSessionId, {
		inputTokens: usage.inputTokens || 0,
		outputTokens: usage.outputTokens || 0,
		cacheReadTokens: usage.cacheReadInputTokens || 0,
		cacheCreationTokens: usage.cacheCreationInputTokens || 0,
		costUsd: usage.totalCostUsd || 0,
		events: 1,
	});
}

/**
 * Take and clear the accumulated usage for a turn.
 *
 * Returns `null` when the turn reported no usage at all - most providers report
 * something, but not all do, and a caller must be able to write "unknown"
 * rather than a fabricated zero.
 */
export function drainTurnUsage(rawSessionId: string): TurnUsage | null {
	const usage = ledger.get(rawSessionId);
	if (!usage) return null;
	ledger.delete(rawSessionId);
	return usage;
}

/**
 * Shape a drained turn for `stats.recordQuery`.
 *
 * Returns an empty object when there is nothing to report, so the caller can
 * spread it unconditionally and the columns stay NULL.
 */
export function turnUsageStatsFields(usage: TurnUsage | null): {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
} {
	if (!usage) return {};
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheCreationTokens: usage.cacheCreationTokens,
		costUsd: usage.costUsd,
	};
}

/**
 * Shape an already-accumulated per-turn `UsageStats` for `recordQuery`.
 *
 * The Auto Run path keeps its own per-task accumulator (it subscribes to
 * `onUsage` locally and resets between tasks), so it has the delta in hand and
 * does not need the ledger. This converts that value to the same field names
 * without a second accumulation path.
 */
export function usageStatsToTurnFields(usage: UsageStats | undefined): {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
} {
	if (!usage) return {};
	return {
		inputTokens: usage.inputTokens || 0,
		outputTokens: usage.outputTokens || 0,
		cacheReadTokens: usage.cacheReadInputTokens || 0,
		cacheCreationTokens: usage.cacheCreationInputTokens || 0,
		costUsd: usage.totalCostUsd || 0,
	};
}

/** Number of in-flight turns being tracked. Test/diagnostic helper. */
export function getTurnUsageLedgerSize(): number {
	return ledger.size;
}

/** Reset the ledger. Tests only. */
export function resetTurnUsageLedgerForTests(): void {
	ledger.clear();
}
