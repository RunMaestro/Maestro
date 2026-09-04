/**
 * Token accounting for Codex CLI rollout transcripts.
 *
 * Codex reports usage in two shapes and only one of them is incremental:
 *
 * - `turn.completed` carries `usage` for THAT turn (legacy / app-server format).
 * - `event_msg` + `payload.type === 'token_count'` carries
 *   `info.last_token_usage` for that turn AND `info.total_token_usage`, which is
 *   the running SESSION TOTAL.
 *
 * Summing `total_token_usage` across events is the trap: a session with N turns
 * then reports 1+2+...+N times its real tokens, so cost grows with the SQUARE of
 * the conversation length. On a real corpus that inflated 1.3B input tokens into
 * 75B and turned a ~$350 estimate into ~$250,000, which is why Codex could
 * outrank Claude on a dashboard driven almost entirely by Claude agents.
 *
 * Every Codex transcript scan goes through this accumulator so the three call
 * sites that used to hand-roll the sum cannot disagree again. No Electron
 * imports, so the CLI can bundle it.
 */

/** Per-turn usage as it appears on `turn.completed` and `info.last_token_usage`. */
export interface CodexUsageRecord {
	input_tokens?: number;
	output_tokens?: number;
	cached_input_tokens?: number;
	reasoning_output_tokens?: number;
	total_tokens?: number;
}

/** The `info` object on a `token_count` event payload. */
export interface CodexTokenCountInfo {
	total_token_usage?: CodexUsageRecord | null;
	last_token_usage?: CodexUsageRecord | null;
	model_context_window?: number;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Accumulates a Codex session's real token totals from its rollout events.
 *
 * Reasoning output is folded into `outputTokens` (it is billed as output), and
 * `cachedTokens` stays a SUBSET of `inputTokens`, matching how Codex reports it.
 * Pricing accounts for that via `CACHE_READ_SUBSET_OF_INPUT` in `modelPricing`.
 */
export class CodexTokenCounts {
	private input = 0;
	private output = 0;
	private cached = 0;
	private sawAny = false;
	/** Last `total_token_usage` seen, for the delta fallback below. */
	private previousTotal: CodexUsageRecord | null = null;

	/** Add a per-turn usage record (`turn.completed.usage`). */
	addTurn(usage: CodexUsageRecord | null | undefined): void {
		if (!usage) return;
		this.input += num(usage.input_tokens);
		this.output += num(usage.output_tokens) + num(usage.reasoning_output_tokens);
		this.cached += num(usage.cached_input_tokens);
		this.sawAny = true;
	}

	/**
	 * Add a `token_count` event. Prefers `last_token_usage` (the turn's own
	 * numbers). When only the cumulative `total_token_usage` is present, adds the
	 * delta since the previous event instead of the whole running total; a total
	 * that moves BACKWARDS means the session restarted its counter (a resume or a
	 * fork), so the new value is taken whole rather than clamped to zero.
	 */
	addTokenCountEvent(info: CodexTokenCountInfo | null | undefined): void {
		if (!info) return;

		if (info.last_token_usage) {
			this.addTurn(info.last_token_usage);
			// Keep the baseline current so a later event that drops
			// `last_token_usage` still produces a correct delta.
			if (info.total_token_usage) this.previousTotal = info.total_token_usage;
			return;
		}

		const total = info.total_token_usage;
		if (!total) return;

		const previous = this.previousTotal;
		const restarted = previous !== null && num(total.input_tokens) < num(previous.input_tokens);
		const base = restarted ? null : previous;

		this.input += num(total.input_tokens) - num(base?.input_tokens);
		this.output +=
			num(total.output_tokens) -
			num(base?.output_tokens) +
			(num(total.reasoning_output_tokens) - num(base?.reasoning_output_tokens));
		this.cached += num(total.cached_input_tokens) - num(base?.cached_input_tokens);
		this.sawAny = true;
		this.previousTotal = total;
	}

	/** Total input tokens, cached ones included (Codex counts them inside input). */
	get inputTokens(): number {
		return this.input;
	}

	/** Total output tokens, reasoning tokens included. */
	get outputTokens(): number {
		return this.output;
	}

	/** Cached input tokens - a SUBSET of {@link inputTokens}, not an addition. */
	get cachedTokens(): number {
		return this.cached;
	}

	/** True when no usage event contributed anything. */
	get isEmpty(): boolean {
		return !this.sawAny || (this.input === 0 && this.output === 0 && this.cached === 0);
	}
}
