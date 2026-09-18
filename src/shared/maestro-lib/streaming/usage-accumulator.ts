/**
 * Usage delta accumulation - maestro-lib Part Two.
 *
 * Ports `normalizeUsageToDelta` (`StdoutHandler.ts:39-132`) into a
 * standalone, instance-scoped primitive so every call site (not just
 * desktop) can delta-normalize cumulative usage reporting the same way.
 * Behavior is a faithful port, not a redesign: same monotonic-delta
 * detection, same cumulative-flag latching once a stream is found to be
 * non-cumulative, same conditional `absoluteUsage` re-attachment.
 *
 * Claude Code and Codex both report CUMULATIVE session totals rather than
 * per-turn values. Used directly, context occupancy would exceed 100% after
 * a few turns. This class detects cumulative reporting (values only ever
 * increase) and converts it to per-turn deltas; a provider whose values
 * don't increase monotonically is assumed to already report per-turn and is
 * passed through unmodified from then on.
 *
 * Scoping is deliberately left to the caller and NOT resolved by this
 * module: one instance per PROCESS reproduces today's desktop behavior
 * exactly (`managedProcess.lastUsageTotals`'s lifetime is the process's).
 * Re-scoping an instance to span a resume boundary (one process per turn,
 * one accumulator per session) is Open Question 5 in
 * `Plans/maestro-lib-turn-contract.md` and needs checking against every
 * provider's first-usage-event shape before it's safe - this class does not
 * make that decision.
 */

import type { UsageStats } from '../../types';

interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

export interface UsageAccumulatorOptions {
	/**
	 * Whether this provider's delta-normalized totals should also be
	 * re-attached as `absoluteUsage` (real context-window occupancy) -
	 * true for combined-context providers (today: Codex only).
	 *
	 * Per the turn contract §3: the canonical source for this is the
	 * `usesCombinedContextWindow` capability flag in
	 * `src/shared/maestro-lib/providers/capabilities.ts`, not the separate
	 * `COMBINED_CONTEXT_AGENTS` static set in `src/shared/agentConstants.ts`
	 * - that module's own comment already says the flag is canonical and
	 * the set exists only "for cross-process use." Pass the resolved
	 * capability value here; this class does not read either source itself.
	 */
	attachesAbsoluteUsage: boolean;
}

export class UsageAccumulator {
	private _lastTotals: UsageTotals | undefined;
	private _isCumulative: boolean | undefined;
	private readonly attachesAbsoluteUsage: boolean;

	constructor(options: UsageAccumulatorOptions) {
		this.attachesAbsoluteUsage = options.attachesAbsoluteUsage;
	}

	/**
	 * The most recent raw totals seen, before delta normalization. Exposed
	 * (as a defensive copy) so a caller that needs to mirror this instance's
	 * state onto its own external record - e.g. `ManagedProcess.
	 * lastUsageTotals`, read directly by `plugin-event-listener.ts` - can do
	 * so without this class knowing anything about that consumer.
	 */
	get lastTotals(): UsageTotals | undefined {
		return this._lastTotals ? { ...this._lastTotals } : undefined;
	}

	/** Whether this stream has been determined to report cumulative totals. `undefined` until the second event arrives. */
	get isCumulative(): boolean | undefined {
		return this._isCumulative;
	}

	/**
	 * Normalize one usage event against everything seen so far on this
	 * instance. The first call always returns its input verbatim (there is
	 * nothing to delta against yet, and it is already an absolute snapshot).
	 */
	normalize(usageStats: UsageStats): UsageStats {
		const totals: UsageTotals = {
			inputTokens: usageStats.inputTokens,
			outputTokens: usageStats.outputTokens,
			cacheReadInputTokens: usageStats.cacheReadInputTokens,
			cacheCreationInputTokens: usageStats.cacheCreationInputTokens,
			reasoningTokens: usageStats.reasoningTokens || 0,
		};

		// Once a stream has been found non-cumulative, stop trying to
		// delta-normalize it - a provider does not switch reporting styles
		// mid-stream, and re-attempting would misclassify a legitimate
		// decrease (e.g. a cache eviction) as the reporting style changing.
		if (this._isCumulative === false) {
			this._lastTotals = totals;
			return usageStats;
		}

		const last = this._lastTotals;
		if (!last) {
			this._lastTotals = totals;
			return usageStats;
		}

		const delta: UsageTotals = {
			inputTokens: totals.inputTokens - last.inputTokens,
			outputTokens: totals.outputTokens - last.outputTokens,
			cacheReadInputTokens: totals.cacheReadInputTokens - last.cacheReadInputTokens,
			cacheCreationInputTokens: totals.cacheCreationInputTokens - last.cacheCreationInputTokens,
			reasoningTokens: totals.reasoningTokens - last.reasoningTokens,
		};

		const isMonotonic =
			delta.inputTokens >= 0 &&
			delta.outputTokens >= 0 &&
			delta.cacheReadInputTokens >= 0 &&
			delta.cacheCreationInputTokens >= 0 &&
			delta.reasoningTokens >= 0;

		if (!isMonotonic) {
			this._isCumulative = false;
			this._lastTotals = totals;
			return usageStats;
		}

		this._isCumulative = true;
		this._lastTotals = totals;

		// `...usageStats` first, so an incoming `absoluteUsage` (e.g.
		// Claude Code's parser-attached last-internal-call snapshot, which is
		// NOT this class's business to compute) survives untouched when this
		// provider doesn't attach one of its own below.
		return {
			...usageStats,
			inputTokens: delta.inputTokens,
			outputTokens: delta.outputTokens,
			cacheReadInputTokens: delta.cacheReadInputTokens,
			cacheCreationInputTokens: delta.cacheCreationInputTokens,
			reasoningTokens: delta.reasoningTokens,
			...(this.attachesAbsoluteUsage
				? {
						absoluteUsage: {
							inputTokens: totals.inputTokens,
							outputTokens: totals.outputTokens,
							cacheReadInputTokens: totals.cacheReadInputTokens,
							cacheCreationInputTokens: totals.cacheCreationInputTokens,
							reasoningTokens: totals.reasoningTokens,
						},
					}
				: {}),
		};
	}
}
