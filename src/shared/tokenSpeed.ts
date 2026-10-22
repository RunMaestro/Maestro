/**
 * Token throughput (tokens per second) measured per API call from provider
 * transcripts.
 *
 * Why per call and not per turn: a Maestro turn spans tool runs, subagent
 * fan-out, and the user reading the screen, so `tokens / turn duration` measures
 * how busy the agent was, not how fast the model produced tokens. A transcript
 * stamps every line, so one API call can be timed from the line that sent its
 * request (the user prompt or tool result before it) to the last line of its
 * response. That window includes time to first token, which is what a user
 * waits through, so the figure is "throughput as experienced", not raw decode.
 *
 * Speed is kept as hourly buckets per model rather than raw samples: a busy
 * month is ~100k calls, and every dashboard question (time of day, over time,
 * per provider, per model, peaks) can be answered from per-hour sums plus a
 * per-hour max. Averages are token-weighted (`sum tokens / sum call time`) so a
 * 2-second call cannot move the average as much as a 2-minute one.
 *
 * Shared because the main process (dashboard) and the CLI read transcripts and
 * must agree on what a call is. No Electron or Node imports.
 */

/** Calls shorter than this are dropped: a line timestamp is too coarse to time them. */
export const TOKEN_SPEED_MIN_CALL_MS = 1_000;

/**
 * Calls longer than this are dropped. No single API call runs this long, so a
 * longer window means the "request sent" line was not the one that started it
 * (a resumed session, a transcript gap).
 */
export const TOKEN_SPEED_MAX_CALL_MS = 15 * 60_000;

/**
 * A peak is the fastest single model-hour (one model's calls within one clock
 * hour, across every session), and that hour needs at least this much measured
 * call time to qualify.
 *
 * Why not the fastest single call: transcript lines are written per content
 * block and some are written late, so a short call can appear to finish tens of
 * thousands of tokens in two seconds. Gating calls by length fixes output but
 * breaks input: prompt throughput is highest on SHORT calls (a large cached
 * prompt answered in a second), so a length-gated input "peak" lands below the
 * input average. A model-hour is an average over many calls, which dilutes a
 * mis-timed call and keeps peak above average for input, output, and total.
 * Measured on 73k real calls: the fastest model-hour was stable whether it
 * needed 1 call or 20.
 */
export const TOKEN_SPEED_PEAK_MIN_BUCKET_MS = 5 * 60_000;

/** One timed API call. */
export interface TokenSpeedSample {
	/** When the response finished (ms since epoch). */
	endMs: number;
	/** Request sent to response finished, in ms. */
	durationMs: number;
	/** Model id as the transcript recorded it ('' when absent). */
	model: string;
	/** Every prompt token the call processed: fresh, cache writes, and cache reads. */
	inputTokens: number;
	/** Generated tokens, reasoning included. */
	outputTokens: number;
}

/** Calls of one model within one local clock hour. */
export interface TokenSpeedBucket {
	/** Local hour start (ms since epoch). */
	startMs: number;
	model: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	/** Sum of the calls' durations, in ms. */
	durationMs: number;
}

/** Throughput over a set of calls. */
export interface TokenSpeedStats {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	/** Token-weighted averages: tokens divided by total call time. 0 when no calls. */
	avgInputTps: number;
	avgOutputTps: number;
	avgTotalTps: number;
	/**
	 * Fastest model-hour average with at least {@link TOKEN_SPEED_PEAK_MIN_BUCKET_MS}
	 * of call time. 0 when no hour qualified.
	 */
	peakInputTps: number;
	peakOutputTps: number;
	peakTotalTps: number;
	/** Hour the output peak happened in, and on which model. */
	peakOutputAtMs?: number;
	peakOutputModel?: string;
}

/** Stats for one provider or one model. */
export interface TokenSpeedGroup extends TokenSpeedStats {
	key: string;
	label: string;
}

/** Stats for one slice of the timeline. */
export interface TokenSpeedPoint extends TokenSpeedStats {
	startMs: number;
}

/**
 * The busiest clock hour across every agent at once: tokens finished in that
 * hour divided by 3,600 seconds. Unlike a per-model peak this is fleet
 * throughput, so it grows with the number of agents running in parallel.
 */
export interface TokenSpeedBusiestHour {
	startMs: number;
	inputTps: number;
	outputTps: number;
	totalTps: number;
}

export type TokenSpeedGranularity = 'hour' | 'day' | 'week' | 'month';

/** The dashboard payload for token speed. */
export interface TokenSpeedSummary {
	overall: TokenSpeedStats;
	byAgent: TokenSpeedGroup[];
	byModel: TokenSpeedGroup[];
	/** 24 entries, local hour of day 0-23. */
	byHourOfDay: TokenSpeedStats[];
	granularity: TokenSpeedGranularity;
	timeline: TokenSpeedPoint[];
	/** Per provider id, aligned to the same bucket starts as `timeline` (gaps omitted). */
	timelineByAgent: Record<string, TokenSpeedPoint[]>;
	/** Per model key, for the busiest models only (see {@link TOKEN_SPEED_TIMELINE_MODELS}). */
	timelineByModel: Record<string, TokenSpeedPoint[]>;
	busiestHour: TokenSpeedBusiestHour | null;
	/** Provider ids whose transcripts carry per-call timing. */
	measuredAgents: string[];
}

/** How many models get their own speed-over-time series. */
export const TOKEN_SPEED_TIMELINE_MODELS = 6;

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/** Start of the local clock hour containing `ms`. */
export function localHourStart(ms: number): number {
	const d = new Date(ms);
	d.setMinutes(0, 0, 0);
	return d.getTime();
}

function isUsableSample(s: TokenSpeedSample): boolean {
	return (
		Number.isFinite(s.endMs) &&
		s.durationMs >= TOKEN_SPEED_MIN_CALL_MS &&
		s.durationMs <= TOKEN_SPEED_MAX_CALL_MS &&
		s.inputTokens + s.outputTokens > 0
	);
}

/** Accumulates samples into hourly per-model buckets. */
export class TokenSpeedBucketer {
	private readonly buckets = new Map<string, TokenSpeedBucket>();

	add(sample: TokenSpeedSample): void {
		if (!isUsableSample(sample)) return;
		const startMs = localHourStart(sample.endMs);
		const key = `${startMs}|${sample.model}`;
		let b = this.buckets.get(key);
		if (!b) {
			b = {
				startMs,
				model: sample.model,
				calls: 0,
				inputTokens: 0,
				outputTokens: 0,
				durationMs: 0,
			};
			this.buckets.set(key, b);
		}
		b.calls++;
		b.inputTokens += sample.inputTokens;
		b.outputTokens += sample.outputTokens;
		b.durationMs += sample.durationMs;
	}

	/** Buckets ordered by time, then model. */
	result(): TokenSpeedBucket[] {
		return [...this.buckets.values()].sort(
			(a, b) => a.startMs - b.startMs || a.model.localeCompare(b.model)
		);
	}
}

// ---------------------------------------------------------------------------
// Claude Code transcripts
// ---------------------------------------------------------------------------

function toCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Time every API call in ONE Claude transcript (a session file or one subagent
 * file - never several joined together, since the line before a file's first
 * response would then belong to a different file).
 *
 * A response is written as one `assistant` line per content block, all sharing
 * `message.id` + `requestId`; its request was sent at the `user` or `assistant`
 * line just before its first block. Other line kinds (progress, system,
 * attachments) are skipped entirely: they are written at unrelated moments, and
 * treating one as the request time is what produces impossible speeds.
 */
export function extractClaudeSpeedSamples(content: string): TokenSpeedSample[] {
	const samples: TokenSpeedSample[] = [];
	let prevMs: number | null = null;
	let cur: (TokenSpeedSample & { key: string; startMs: number }) | null = null;

	const flush = () => {
		if (cur) {
			cur.durationMs = cur.endMs - cur.startMs;
			samples.push({
				endMs: cur.endMs,
				durationMs: cur.durationMs,
				model: cur.model,
				inputTokens: cur.inputTokens,
				outputTokens: cur.outputTokens,
			});
		}
		cur = null;
	};

	for (const line of content.split('\n')) {
		// Cheap prefilter: only assistant lines (which carry usage) and user lines
		// can move the clock. Progress lines can embed a nested user message, so
		// the top-level type is still checked after parsing.
		if (line.indexOf('"usage"') === -1 && line.indexOf('"type":"user"') === -1) continue;
		let entry: {
			type?: unknown;
			timestamp?: unknown;
			requestId?: unknown;
			message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== 'user' && entry.type !== 'assistant') continue;
		const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
		if (!Number.isFinite(ts)) continue;

		if (entry.type === 'assistant') {
			const id = entry.message?.id;
			const key = typeof id === 'string' && id ? `${id}:${String(entry.requestId ?? '')}` : '';
			const usage = entry.message?.usage;
			if (cur && key && cur.key === key) {
				cur.endMs = ts;
				// Usage is repeated per block; keep the largest output count seen.
				if (usage) cur.outputTokens = Math.max(cur.outputTokens, toCount(usage.output_tokens));
				prevMs = ts;
				continue;
			}
			flush();
			const model = typeof entry.message?.model === 'string' ? entry.message.model : '';
			if (key && usage && prevMs !== null && model !== '<synthetic>') {
				cur = {
					key,
					startMs: prevMs,
					endMs: ts,
					durationMs: 0,
					model,
					inputTokens:
						toCount(usage.input_tokens) +
						toCount(usage.cache_creation_input_tokens) +
						toCount(usage.cache_read_input_tokens),
					outputTokens: toCount(usage.output_tokens),
				};
			}
		} else {
			flush();
		}
		prevMs = ts;
	}
	flush();
	return samples;
}

/** Hourly speed buckets for a Claude session: its own transcript plus each subagent's. */
export function computeClaudeTokenSpeed(contents: readonly string[]): TokenSpeedBucket[] {
	const bucketer = new TokenSpeedBucketer();
	for (const content of contents) {
		for (const sample of extractClaudeSpeedSamples(content)) bucketer.add(sample);
	}
	return bucketer.result();
}

// ---------------------------------------------------------------------------
// Codex rollout transcripts
// ---------------------------------------------------------------------------

interface CodexUsageLike {
	input_tokens?: unknown;
	output_tokens?: unknown;
	reasoning_output_tokens?: unknown;
}

/**
 * Times Codex API calls while a rollout is parsed line by line.
 *
 * Current Codex writes a `token_usage_record` the moment a response finishes,
 * then runs its tools, then writes a `token_count` event; the next request goes
 * out after that event. Older rollouts have no record, so the `token_count`
 * event itself ends the call. A user message starts a new turn's first request.
 * Codex counts cached tokens INSIDE `input_tokens`, which matches this module's
 * "every prompt token" definition without adding anything.
 */
export class CodexTokenSpeedTracker {
	private readonly bucketer = new TokenSpeedBucketer();
	private startMs: number | null = null;
	private recordedSinceCount = false;

	/** Feed one parsed rollout line with the model in effect at that point. */
	observe(entry: unknown, model: string | undefined): void {
		if (!entry || typeof entry !== 'object') return;
		const e = entry as {
			type?: unknown;
			timestamp?: unknown;
			payload?: {
				type?: unknown;
				role?: unknown;
				usage?: CodexUsageLike;
				info?: { last_token_usage?: CodexUsageLike | null } | null;
			};
		};
		const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
		if (!Number.isFinite(ts)) return;

		if (e.type === 'token_usage_record' && e.payload?.usage) {
			this.sample(ts, e.payload.usage, model);
			this.recordedSinceCount = true;
			return;
		}
		if (e.type === 'event_msg' && e.payload?.type === 'token_count') {
			const last = e.payload.info?.last_token_usage;
			if (!this.recordedSinceCount && last) this.sample(ts, last, model);
			this.recordedSinceCount = false;
			this.startMs = ts;
			return;
		}
		if (e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user') {
			this.startMs = ts;
		}
	}

	private sample(endMs: number, usage: CodexUsageLike, model: string | undefined): void {
		if (this.startMs === null) return;
		this.bucketer.add({
			endMs,
			durationMs: endMs - this.startMs,
			model: model ?? '',
			inputTokens: toCount(usage.input_tokens),
			outputTokens: toCount(usage.output_tokens) + toCount(usage.reasoning_output_tokens),
		});
		this.startMs = null;
	}

	result(): TokenSpeedBucket[] {
		return this.bucketer.result();
	}
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Running sums behind one {@link TokenSpeedStats}. */
export class TokenSpeedAccumulator {
	calls = 0;
	inputTokens = 0;
	outputTokens = 0;
	durationMs = 0;
	peakInputTps = 0;
	peakOutputTps = 0;
	peakTotalTps = 0;
	peakOutputAtMs: number | undefined;
	peakOutputModel: string | undefined;

	/**
	 * Add one MODEL-HOUR: a bucket already merged across sessions. A bucket from
	 * a single session would set peaks from too few calls.
	 */
	add(b: TokenSpeedBucket): void {
		this.calls += b.calls;
		this.inputTokens += b.inputTokens;
		this.outputTokens += b.outputTokens;
		this.durationMs += b.durationMs;
		if (b.durationMs < TOKEN_SPEED_PEAK_MIN_BUCKET_MS) return;
		const secs = b.durationMs / 1000;
		this.peakInputTps = Math.max(this.peakInputTps, b.inputTokens / secs);
		this.peakTotalTps = Math.max(this.peakTotalTps, (b.inputTokens + b.outputTokens) / secs);
		if (b.outputTokens / secs > this.peakOutputTps) {
			this.peakOutputTps = b.outputTokens / secs;
			this.peakOutputAtMs = b.startMs;
			this.peakOutputModel = b.model;
		}
	}

	stats(): TokenSpeedStats {
		const secs = this.durationMs / 1000;
		const rate = (tokens: number) => (secs > 0 ? tokens / secs : 0);
		return {
			calls: this.calls,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			durationMs: this.durationMs,
			avgInputTps: rate(this.inputTokens),
			avgOutputTps: rate(this.outputTokens),
			avgTotalTps: rate(this.inputTokens + this.outputTokens),
			peakInputTps: this.peakInputTps,
			peakOutputTps: this.peakOutputTps,
			peakTotalTps: this.peakTotalTps,
			...(this.peakOutputAtMs !== undefined ? { peakOutputAtMs: this.peakOutputAtMs } : {}),
			...(this.peakOutputModel !== undefined ? { peakOutputModel: this.peakOutputModel } : {}),
		};
	}
}

/** Pick a timeline granularity that gives a readable number of points for a span. */
export function tokenSpeedGranularityFor(spanMs: number): TokenSpeedGranularity {
	const day = 24 * 60 * 60 * 1000;
	if (spanMs <= 2 * day) return 'hour';
	if (spanMs <= 92 * day) return 'day';
	if (spanMs <= 400 * day) return 'week';
	return 'month';
}

/** Start of the timeline slice containing `ms` (local time; weeks start Monday). */
export function tokenSpeedSliceStart(ms: number, granularity: TokenSpeedGranularity): number {
	if (granularity === 'hour') return localHourStart(ms);
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	if (granularity === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	else if (granularity === 'month') d.setDate(1);
	return d.getTime();
}

/** One session's buckets plus who produced them. */
export interface TokenSpeedSource {
	agentType: string;
	buckets: readonly TokenSpeedBucket[];
}

export interface TokenSpeedSummaryOptions {
	sinceMs?: number;
	untilMs?: number;
	/** Display label for a provider id. */
	agentLabel: (agentType: string) => string;
	/** Grouping key for a raw model id (e.g. normalization). */
	modelKey: (model: string) => string;
	/** Display label for a model key. */
	modelLabel: (modelKey: string) => string;
	/** Fixes "now" for the span of an open-ended window (tests). */
	nowMs?: number;
}

function toGroups(map: Map<string, TokenSpeedAccumulator>, label: (key: string) => string) {
	const groups: TokenSpeedGroup[] = [];
	for (const [key, acc] of map) groups.push({ key, label: label(key), ...acc.stats() });
	return groups.sort((a, b) => b.outputTokens - a.outputTokens);
}

function toPoints(map: Map<number, TokenSpeedAccumulator>): TokenSpeedPoint[] {
	return [...map.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([startMs, acc]) => ({ startMs, ...acc.stats() }));
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
	let value = map.get(key);
	if (value === undefined) {
		value = make();
		map.set(key, value);
	}
	return value;
}

/** A summary with no measured calls (fallbacks and fixtures). */
export function emptyTokenSpeedSummary(): TokenSpeedSummary {
	const none = new TokenSpeedAccumulator().stats();
	return {
		overall: none,
		byAgent: [],
		byModel: [],
		byHourOfDay: Array.from({ length: 24 }, () => ({ ...none })),
		granularity: 'day',
		timeline: [],
		timelineByAgent: {},
		timelineByModel: {},
		busiestHour: null,
		measuredAgents: [],
	};
}

/** Roll session buckets up into the dashboard's speed payload for a window. */
export function summarizeTokenSpeed(
	sources: Iterable<TokenSpeedSource>,
	options: TokenSpeedSummaryOptions
): TokenSpeedSummary {
	const sinceMs = options.sinceMs ?? -Infinity;
	const untilMs = options.untilMs ?? Infinity;
	// A bucket is an hour, so the hour the window opens in counts as inside it.
	const minStartMs = Number.isFinite(sinceMs) ? localHourStart(sinceMs) : -Infinity;
	// Merge every session's buckets into model-hours (per provider), keyed by the
	// normalized model so one model's spellings land together. Peaks are read
	// from these merged hours, never from one session's slice of an hour.
	const merged = new Map<string, { agentType: string; bucket: TokenSpeedBucket }>();
	let earliest = Infinity;
	for (const source of sources) {
		for (const bucket of source.buckets) {
			if (bucket.startMs < minStartMs || bucket.startMs > untilMs) continue;
			const model = options.modelKey(bucket.model);
			const key = `${source.agentType}|${model}|${bucket.startMs}`;
			const entry = merged.get(key);
			if (entry) {
				entry.bucket.calls += bucket.calls;
				entry.bucket.inputTokens += bucket.inputTokens;
				entry.bucket.outputTokens += bucket.outputTokens;
				entry.bucket.durationMs += bucket.durationMs;
			} else {
				merged.set(key, { agentType: source.agentType, bucket: { ...bucket, model } });
			}
			if (bucket.startMs < earliest) earliest = bucket.startMs;
		}
	}
	const inWindow = [...merged.values()];

	const nowMs = options.nowMs ?? Date.now();
	const spanStart = Number.isFinite(sinceMs) ? sinceMs : earliest;
	const spanEnd = Number.isFinite(untilMs) ? untilMs : nowMs;
	const granularity = tokenSpeedGranularityFor(
		Number.isFinite(spanStart) ? Math.max(0, spanEnd - spanStart) : 0
	);

	const overall = new TokenSpeedAccumulator();
	const byAgent = new Map<string, TokenSpeedAccumulator>();
	const byModel = new Map<string, TokenSpeedAccumulator>();
	const byHourOfDay = Array.from({ length: 24 }, () => new TokenSpeedAccumulator());
	const timeline = new Map<number, TokenSpeedAccumulator>();
	const timelineByAgent = new Map<string, Map<number, TokenSpeedAccumulator>>();
	const timelineByModel = new Map<string, Map<number, TokenSpeedAccumulator>>();
	const tokensByHour = new Map<number, { input: number; output: number }>();
	const make = () => new TokenSpeedAccumulator();

	for (const { agentType, bucket } of inWindow) {
		const modelKey = bucket.model;
		const slice = tokenSpeedSliceStart(bucket.startMs, granularity);
		overall.add(bucket);
		getOrCreate(byAgent, agentType, make).add(bucket);
		getOrCreate(byModel, modelKey, make).add(bucket);
		byHourOfDay[new Date(bucket.startMs).getHours()].add(bucket);
		getOrCreate(timeline, slice, make).add(bucket);
		getOrCreate(
			getOrCreate(timelineByAgent, agentType, () => new Map()),
			slice,
			make
		).add(bucket);
		getOrCreate(
			getOrCreate(timelineByModel, modelKey, () => new Map()),
			slice,
			make
		).add(bucket);
		const hour = getOrCreate(tokensByHour, bucket.startMs, () => ({ input: 0, output: 0 }));
		hour.input += bucket.inputTokens;
		hour.output += bucket.outputTokens;
	}

	let busiestHour: TokenSpeedBusiestHour | null = null;
	for (const [startMs, t] of tokensByHour) {
		const totalTps = (t.input + t.output) / 3600;
		if (!busiestHour || totalTps > busiestHour.totalTps) {
			busiestHour = { startMs, inputTps: t.input / 3600, outputTps: t.output / 3600, totalTps };
		}
	}

	const modelGroups = toGroups(byModel, options.modelLabel);
	const timelineModels = new Set(
		modelGroups.slice(0, TOKEN_SPEED_TIMELINE_MODELS).map((g) => g.key)
	);

	return {
		overall: overall.stats(),
		byAgent: toGroups(byAgent, options.agentLabel),
		byModel: modelGroups,
		byHourOfDay: byHourOfDay.map((acc) => acc.stats()),
		granularity,
		timeline: toPoints(timeline),
		timelineByAgent: Object.fromEntries(
			[...timelineByAgent].map(([agent, points]) => [agent, toPoints(points)])
		),
		timelineByModel: Object.fromEntries(
			[...timelineByModel]
				.filter(([model]) => timelineModels.has(model))
				.map(([model, points]) => [model, toPoints(points)])
		),
		busiestHour,
		measuredAgents: [...byAgent.keys()].sort(),
	};
}
