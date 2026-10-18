/**
 * Tokens-per-second rate engine behind the Throughput Gauge.
 *
 * Pure: no React, no `window`, no timers. Every call takes the time as `nowMs`
 * (pass a monotonic clock such as `performance.now()`), so the caller's timer
 * drives it and a test drives it by hand.
 *
 * Credit ahead, then correct. Two live signals credit tokens before the turn's
 * usage report does:
 *
 * - Per-call usage (`recordCallUsage`), when the provider sends it (claude-code
 *   reports every internal API call's spend as the call lands). Real counts, in
 *   both directions, and the better signal: from a source's first call report
 *   on, its text is not estimated at all, since the call already counted it.
 * - Streamed text, which credits OUTPUT at once from `estimateTokenCount()`.
 *   The only live signal for providers that report usage once per turn.
 *
 * The turn's usage report is the truth: it credits `max(0, real - ahead)` per
 * direction, where `ahead` is what the live signals credited for that source
 * since its previous report, and zeroes `ahead`. No rate goes negative, and
 * whenever the live signals undershoot (tool calls and redacted thinking never
 * stream as text) the credited total lands exactly on the reported count. An
 * overshoot is not clawed back.
 *
 * INPUT comes only from usage reports: uncached input plus cache writes. Cache
 * READS are left out on purpose. They are re-reads of context the provider
 * already holds, nearly all of a resumed session's input, so counting them
 * would pin the needle on every turn. Codex and Copilot report reads INSIDE
 * `inputTokens` (`COMBINED_CONTEXT_AGENTS`), so for them the reads are
 * subtracted rather than skipped.
 *
 * Without per-call usage a turn that is mostly tool calls credits almost
 * nothing until it ends, then its whole spend in one sample: a dead gauge with
 * a spike. That is why per-call usage exists.
 *
 * Late text. Main sends a usage event the moment it parses one but coalesces
 * text (16ms for `process:data`, 50ms for thinking chunks), so the tail of a
 * turn's text arrives AFTER the report that already counted it. Crediting that
 * tail would count it twice with nothing left to correct it, so reply text is
 * refused once its source has reported usage, and streamed text is refused for
 * `usageSettleMs` after each report. Refusing text never loses tokens: the next
 * report credits whatever the estimate missed.
 *
 * `sourceId` is the RAW process session id, never the agent id: a forced-parallel
 * turn (`{id}-ai-{tab}-fp-{ts}`) runs beside the tab's normal turn, and merging
 * them would correct one turn's estimate with the other's usage. `agentId` is
 * only the scope key `rates()` filters on.
 */

import { COMBINED_CONTEXT_AGENTS } from './agentConstants';
import type { AgentId } from './agentIds';
import { estimateTokenCount } from './formatters';
import type { UsageStats } from './types';

/** Which reading a gauge shows. */
export type ThroughputMetric = 'combined' | 'in' | 'out';

/** Tokens credited at one moment by one process. */
export interface ThroughputSample {
	atMs: number;
	inTokens: number;
	outTokens: number;
	/** Raw process session id that produced the tokens. */
	sourceId: string;
	/** Agent the source belongs to: the scope key. */
	agentId: string;
}

/** Rolling rates in tokens per second. `combined` is always `in + out`. */
export interface ThroughputRates {
	in: number;
	out: number;
	combined: number;
}

/** Rolling-average windows the gauge offers. */
export const THROUGHPUT_WINDOWS_MS = [5000, 10000, 30000, 60000] as const;

export type ThroughputWindowMs = (typeof THROUGHPUT_WINDOWS_MS)[number];

export const DEFAULT_THROUGHPUT_WINDOW_MS: ThroughputWindowMs = 10000;

/**
 * Default sample retention: the largest window plus a second, so a window read
 * on a clock slightly behind the last prune still sees every sample it covers.
 */
export const DEFAULT_THROUGHPUT_RETENTION_MS = Math.max(...THROUGHPUT_WINDOWS_MS) + 1000;

/**
 * Default quiet period after a usage report, during which a source's streamed
 * text is taken as the coalesced tail of output that report already counted.
 * Ten times main's 50ms thinking-chunk flush, so a busy event loop still fits.
 */
export const DEFAULT_THROUGHPUT_USAGE_SETTLE_MS = 500;

/**
 * Cap on per-source state. `forgetSource()` on exit normally drops every entry,
 * but an exit this window never sees (the agent moved to another window
 * mid-turn) would leak one for the life of the app. The oldest insertion goes
 * first: it is the turn least likely to still be running.
 */
const MAX_TRACKED_SOURCES = 500;

/** The usage fields the tracker reads. A `process.onUsage` payload fits as is. */
export type ThroughputUsage = Partial<
	Pick<
		UsageStats,
		| 'inputTokens'
		| 'outputTokens'
		| 'cacheReadInputTokens'
		| 'cacheCreationInputTokens'
		| 'contextWindowCorrectionOnly'
	>
>;

export interface ThroughputTrackerOptions {
	/** How long samples are kept. Defaults to {@link DEFAULT_THROUGHPUT_RETENTION_MS}. */
	maxRetentionMs?: number;
	/** Quiet period after a usage report. Defaults to {@link DEFAULT_THROUGHPUT_USAGE_SETTLE_MS}. */
	usageSettleMs?: number;
}

export interface ThroughputTracker {
	/**
	 * Credit live streamed text (a thinking chunk) as estimated output. Refused
	 * for `usageSettleMs` after the source's last usage report, and always once
	 * the source sends call reports.
	 */
	recordStreamedText(sourceId: string, agentId: string, text: string, nowMs: number): void;
	/**
	 * Credit reply text (`process:data`) as estimated output, but only until the
	 * source first reports usage. From then until `forgetSource()` it is the
	 * finished reply a structured-output provider re-sends at turn end, which
	 * that report already counted.
	 */
	recordReplyText(sourceId: string, agentId: string, text: string, nowMs: number): void;
	/**
	 * Credit one API call's new spend (`process.onCallUsage`) at once, input by
	 * the same rule as `recordUsage`, and hold it against the source's next usage
	 * report. From then until `forgetSource()` the source's text is refused: the
	 * call reports carry its output.
	 */
	recordCallUsage(
		sourceId: string,
		agentId: string,
		usage: ThroughputUsage,
		nowMs: number,
		provider?: AgentId
	): void;
	/**
	 * Credit one usage report (a per-turn delta from `process.onUsage`): input as
	 * uncached input plus cache writes, each direction as the real count minus
	 * what live signals credited ahead of it since the last report (never below
	 * zero), then zero those. `provider` is the agent's `toolType`; it decides
	 * whether cache reads sit inside `inputTokens`. A `contextWindowCorrectionOnly`
	 * replay is ignored.
	 */
	recordUsage(
		sourceId: string,
		agentId: string,
		usage: ThroughputUsage,
		nowMs: number,
		provider?: AgentId
	): void;
	/** Drop a source's estimate and usage state. Call when its process exits. */
	forgetSource(sourceId: string): void;
	/**
	 * Rolling rates over the last `windowMs`, the interval
	 * `(nowMs - windowMs, nowMs]`: tokens in it divided by its length in seconds.
	 * `filter` narrows the samples, which is how scope (one agent) is applied.
	 */
	rates(
		nowMs: number,
		windowMs: number,
		filter?: (sample: ThroughputSample) => boolean
	): ThroughputRates;
	/** Drop samples older than `maxRetentionMs`. */
	prune(nowMs: number): void;
	/** Drop every sample and all source state. */
	clear(): void;
	/** Samples currently held. Diagnostic. */
	sampleCount(): number;
	/** Sources currently holding estimate or usage state. Diagnostic. */
	sourceCount(): number;
}

interface SourceState {
	/** Input credited by call reports since the last usage report. */
	aheadIn: number;
	/** Output credited by text estimates or call reports since the last usage report. */
	aheadOut: number;
	/** Set by the first call report; refuses text until forgotten. */
	reportsCalls: boolean;
	/** Set by the first usage report; refuses reply text until forgotten. */
	reportedUsage: boolean;
	/** Stamp of the last usage report. */
	usageAtMs: number;
}

/** A token count off a provider payload: anything but a positive finite number is 0. */
function tokenCount(value: number | undefined): number {
	return typeof value === 'number' && value > 0 && Number.isFinite(value) ? value : 0;
}

export function createThroughputTracker(options: ThroughputTrackerOptions = {}): ThroughputTracker {
	const maxRetentionMs = options.maxRetentionMs ?? DEFAULT_THROUGHPUT_RETENTION_MS;
	const usageSettleMs = options.usageSettleMs ?? DEFAULT_THROUGHPUT_USAGE_SETTLE_MS;

	// Oldest first. Samples before `head` are pruned and wait for one compaction,
	// so pruning never shifts the array an element at a time.
	const samples: ThroughputSample[] = [];
	let head = 0;
	// Newest stamp handed out. A caller clock that steps back is clamped to it, so
	// `samples` stays in time order and `rates()` can stop at the window edge.
	let latestMs = Number.NEGATIVE_INFINITY;
	const sources = new Map<string, SourceState>();

	function stamp(nowMs: number): number {
		if (nowMs > latestMs) latestMs = nowMs;
		return latestMs;
	}

	function sourceState(sourceId: string): SourceState {
		const existing = sources.get(sourceId);
		if (existing) return existing;
		if (sources.size >= MAX_TRACKED_SOURCES) {
			const oldest = sources.keys().next();
			if (!oldest.done) sources.delete(oldest.value);
		}
		const created: SourceState = {
			aheadIn: 0,
			aheadOut: 0,
			reportsCalls: false,
			reportedUsage: false,
			usageAtMs: 0,
		};
		sources.set(sourceId, created);
		return created;
	}

	function creditText(sourceId: string, agentId: string, text: string, nowMs: number): void {
		const tokens = estimateTokenCount(text);
		if (tokens === 0) return;
		const atMs = stamp(nowMs);
		const state = sourceState(sourceId);
		if (state.reportsCalls) return;
		if (state.reportedUsage && atMs - state.usageAtMs < usageSettleMs) return;
		state.aheadOut += tokens;
		samples.push({ atMs, inTokens: 0, outTokens: tokens, sourceId, agentId });
	}

	/** Input a usage payload counts: uncached input plus cache writes. */
	function inputOf(usage: ThroughputUsage, provider: AgentId | undefined): number {
		const input = tokenCount(usage.inputTokens);
		const uncachedInput =
			provider !== undefined && COMBINED_CONTEXT_AGENTS.has(provider)
				? Math.max(0, input - tokenCount(usage.cacheReadInputTokens))
				: input;
		return uncachedInput + tokenCount(usage.cacheCreationInputTokens);
	}

	function pushSample(
		atMs: number,
		inTokens: number,
		outTokens: number,
		sourceId: string,
		agentId: string
	): void {
		if (inTokens > 0 || outTokens > 0) {
			samples.push({ atMs, inTokens, outTokens, sourceId, agentId });
		}
	}

	return {
		recordStreamedText: creditText,

		recordCallUsage(sourceId, agentId, usage, nowMs, provider) {
			const atMs = stamp(nowMs);
			const state = sourceState(sourceId);
			const inTokens = inputOf(usage, provider);
			const outTokens = tokenCount(usage.outputTokens);
			state.reportsCalls = true;
			state.aheadIn += inTokens;
			state.aheadOut += outTokens;
			pushSample(atMs, inTokens, outTokens, sourceId, agentId);
		},

		recordReplyText(sourceId, agentId, text, nowMs) {
			if (sources.get(sourceId)?.reportedUsage) return;
			creditText(sourceId, agentId, text, nowMs);
		},

		recordUsage(sourceId, agentId, usage, nowMs, provider) {
			// A replay of a turn already counted, sent only to fix a context window.
			if (usage.contextWindowCorrectionOnly) return;
			const atMs = stamp(nowMs);
			const state = sourceState(sourceId);
			const inTokens = Math.max(0, inputOf(usage, provider) - state.aheadIn);
			const outTokens = Math.max(0, tokenCount(usage.outputTokens) - state.aheadOut);
			state.aheadIn = 0;
			state.aheadOut = 0;
			state.reportedUsage = true;
			state.usageAtMs = atMs;
			pushSample(atMs, inTokens, outTokens, sourceId, agentId);
		},

		forgetSource(sourceId) {
			sources.delete(sourceId);
		},

		rates(nowMs, windowMs, filter) {
			if (!(windowMs > 0)) return { in: 0, out: 0, combined: 0 };
			const edge = nowMs - windowMs;
			let inSum = 0;
			let outSum = 0;
			// Newest first: time order means the first sample past the edge ends the scan.
			for (let i = samples.length - 1; i >= head; i--) {
				const sample = samples[i];
				if (sample.atMs <= edge) break;
				if (sample.atMs > nowMs || (filter && !filter(sample))) continue;
				inSum += sample.inTokens;
				outSum += sample.outTokens;
			}
			const seconds = windowMs / 1000;
			const inRate = inSum / seconds;
			const outRate = outSum / seconds;
			return { in: inRate, out: outRate, combined: inRate + outRate };
		},

		prune(nowMs) {
			const edge = nowMs - maxRetentionMs;
			while (head < samples.length && samples[head].atMs <= edge) head++;
			if (head === samples.length) {
				samples.length = 0;
				head = 0;
			} else if (head * 2 >= samples.length) {
				// Compact once at least half the array is dead: amortized O(1) a sample.
				samples.copyWithin(0, head);
				samples.length -= head;
				head = 0;
			}
		},

		clear() {
			samples.length = 0;
			head = 0;
			latestMs = Number.NEGATIVE_INFINITY;
			sources.clear();
		},

		sampleCount() {
			return samples.length - head;
		},

		sourceCount() {
			return sources.size;
		},
	};
}
