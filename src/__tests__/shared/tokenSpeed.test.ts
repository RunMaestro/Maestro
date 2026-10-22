import { describe, it, expect } from 'vitest';
import {
	CodexTokenSpeedTracker,
	TOKEN_SPEED_MAX_CALL_MS,
	TOKEN_SPEED_PEAK_MIN_BUCKET_MS,
	TokenSpeedBucketer,
	computeClaudeTokenSpeed,
	emptyTokenSpeedSummary,
	extractClaudeSpeedSamples,
	localHourStart,
	summarizeTokenSpeed,
	tokenSpeedGranularityFor,
	tokenSpeedSliceStart,
	type TokenSpeedBucket,
	type TokenSpeedSummaryOptions,
} from '../../shared/tokenSpeed';

/** A fixed local time, so hour bucketing is independent of the test machine's zone. */
const BASE = new Date(2026, 9, 15, 10, 0, 0, 0).getTime();
const at = (secondsAfterBase: number) => new Date(BASE + secondsAfterBase * 1000).toISOString();

function userLine(seconds: number): string {
	return JSON.stringify({
		type: 'user',
		timestamp: at(seconds),
		message: { role: 'user', content: 'go' },
	});
}

function assistantLine(
	seconds: number,
	opts: {
		id: string;
		requestId?: string;
		model?: string;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	}
): string {
	return JSON.stringify({
		type: 'assistant',
		timestamp: at(seconds),
		requestId: opts.requestId ?? `req_${opts.id}`,
		message: {
			id: opts.id,
			model: opts.model ?? 'claude-opus-5-5',
			usage: {
				input_tokens: opts.input ?? 10,
				output_tokens: opts.output ?? 100,
				cache_read_input_tokens: opts.cacheRead ?? 0,
				cache_creation_input_tokens: opts.cacheWrite ?? 0,
			},
		},
	});
}

const OPTIONS: TokenSpeedSummaryOptions = {
	agentLabel: (agent) => `label:${agent}`,
	modelKey: (model) => model || 'unknown',
	modelLabel: (key) => key,
	nowMs: BASE + 3_600_000,
};

function bucket(overrides: Partial<TokenSpeedBucket>): TokenSpeedBucket {
	return {
		startMs: BASE,
		model: 'claude-opus-5-5',
		calls: 1,
		inputTokens: 0,
		outputTokens: 0,
		durationMs: 1000,
		...overrides,
	};
}

describe('extractClaudeSpeedSamples', () => {
	it('times a response from the line that sent its request to its last block', () => {
		const content = [
			userLine(0),
			assistantLine(4, { id: 'm1', output: 50, input: 5, cacheRead: 1000, cacheWrite: 20 }),
			assistantLine(10, { id: 'm1', output: 50, input: 5, cacheRead: 1000, cacheWrite: 20 }),
		].join('\n');

		expect(extractClaudeSpeedSamples(content)).toEqual([
			{
				endMs: BASE + 10_000,
				durationMs: 10_000,
				model: 'claude-opus-5-5',
				// Every prompt token the call processed: fresh + cache write + cache read.
				inputTokens: 1025,
				outputTokens: 50,
			},
		]);
	});

	it('counts a response repeated across content blocks once, keeping the largest output', () => {
		const content = [
			userLine(0),
			assistantLine(2, { id: 'm1', output: 10 }),
			assistantLine(3, { id: 'm1', output: 80 }),
			assistantLine(5, { id: 'm1', output: 80 }),
		].join('\n');

		const samples = extractClaudeSpeedSamples(content);
		expect(samples).toHaveLength(1);
		expect(samples[0].outputTokens).toBe(80);
		expect(samples[0].durationMs).toBe(5000);
	});

	it('starts each follow-up call at the tool result before it', () => {
		const content = [
			userLine(0),
			assistantLine(3, { id: 'm1' }),
			userLine(20), // tool result after a 17s tool run
			assistantLine(26, { id: 'm2' }),
		].join('\n');

		expect(extractClaudeSpeedSamples(content).map((s) => s.durationMs)).toEqual([3000, 6000]);
	});

	it('ignores progress and system lines when deciding when a request was sent', () => {
		const progress = JSON.stringify({
			type: 'progress',
			timestamp: at(9),
			data: { message: { type: 'user', message: { content: 'nested' } } },
		});
		const system = JSON.stringify({ type: 'system', timestamp: at(9), content: 'x' });
		const content = [userLine(0), progress, system, assistantLine(10, { id: 'm1' })].join('\n');

		expect(extractClaudeSpeedSamples(content)[0].durationMs).toBe(10_000);
	});

	it('skips a response with no line before it and synthetic responses', () => {
		const content = [
			assistantLine(1, { id: 'orphan' }),
			userLine(2),
			assistantLine(4, { id: 'syn', model: '<synthetic>' }),
		].join('\n');

		expect(extractClaudeSpeedSamples(content)).toEqual([]);
	});

	it('tolerates malformed lines', () => {
		const content = [userLine(0), '{"usage": not json', assistantLine(2, { id: 'm1' })].join('\n');
		expect(extractClaudeSpeedSamples(content)).toHaveLength(1);
	});
});

describe('computeClaudeTokenSpeed', () => {
	it('times each transcript on its own, so a subagent call is not timed from the parent', () => {
		const parent = [userLine(0), assistantLine(5, { id: 'p1', output: 100 })].join('\n');
		// The subagent's first line comes long after the parent's last one; joined
		// into one document it would time the subagent's first call from t=5.
		const subagent = [userLine(600), assistantLine(610, { id: 's1', output: 200 })].join('\n');

		const [b] = computeClaudeTokenSpeed([parent, subagent]);
		expect(b.calls).toBe(2);
		expect(b.durationMs).toBe(15_000);
		expect(b.outputTokens).toBe(300);
	});
});

describe('TokenSpeedBucketer', () => {
	it('buckets calls by local hour and model, dropping untimeable calls', () => {
		const bucketer = new TokenSpeedBucketer();
		const base = { model: 'm', inputTokens: 10, outputTokens: 10 };
		bucketer.add({ ...base, endMs: BASE + 60_000, durationMs: 2000 });
		bucketer.add({ ...base, endMs: BASE + 120_000, durationMs: 3000 });
		bucketer.add({ ...base, endMs: BASE + 3_700_000, durationMs: 2000 });
		bucketer.add({ ...base, model: 'other', endMs: BASE + 60_000, durationMs: 2000 });
		// Too short to time, too long to be one call, and empty.
		bucketer.add({ ...base, endMs: BASE, durationMs: 500 });
		bucketer.add({ ...base, endMs: BASE, durationMs: TOKEN_SPEED_MAX_CALL_MS + 1 });
		bucketer.add({ model: 'm', endMs: BASE, durationMs: 2000, inputTokens: 0, outputTokens: 0 });

		const result = bucketer.result();
		expect(result.map((b) => [b.startMs - BASE, b.model, b.calls, b.durationMs])).toEqual([
			[0, 'm', 2, 5000],
			[0, 'other', 1, 2000],
			[3_600_000, 'm', 1, 2000],
		]);
	});
});

describe('CodexTokenSpeedTracker', () => {
	const line = (seconds: number, type: string, payload?: unknown) => ({
		timestamp: at(seconds),
		type,
		payload,
	});

	it('times a response from the user message to its token_usage_record', () => {
		const t = new CodexTokenSpeedTracker();
		t.observe(line(0, 'response_item', { type: 'message', role: 'user' }), 'gpt-6');
		t.observe(
			line(8, 'token_usage_record', {
				usage: { input_tokens: 4000, output_tokens: 60, reasoning_output_tokens: 20 },
			}),
			'gpt-6'
		);
		// The token_count that follows the tools describes the same response.
		t.observe(
			line(9, 'event_msg', {
				type: 'token_count',
				info: { last_token_usage: { input_tokens: 4000, output_tokens: 60 } },
			}),
			'gpt-6'
		);
		// The next request goes out after that token_count.
		t.observe(
			line(13, 'token_usage_record', { usage: { input_tokens: 5000, output_tokens: 40 } }),
			'gpt-6'
		);

		const [b] = t.result();
		expect(b.model).toBe('gpt-6');
		expect(b.calls).toBe(2);
		expect(b.durationMs).toBe(8000 + 4000);
		expect(b.inputTokens).toBe(9000);
		// Reasoning is billed as output and counted as output.
		expect(b.outputTokens).toBe(120);
	});

	it('ends a call at token_count when the rollout predates token_usage_record', () => {
		const t = new CodexTokenSpeedTracker();
		t.observe(line(0, 'response_item', { type: 'message', role: 'user' }), 'gpt-5');
		t.observe(
			line(5, 'event_msg', {
				type: 'token_count',
				info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } },
			}),
			'gpt-5'
		);

		const [b] = t.result();
		expect(b.calls).toBe(1);
		expect(b.durationMs).toBe(5000);
	});

	it('ignores usage with no known request start', () => {
		const t = new CodexTokenSpeedTracker();
		t.observe(line(5, 'token_usage_record', { usage: { output_tokens: 50 } }), 'gpt-5');
		t.observe(null, 'gpt-5');
		t.observe({ type: 'event_msg' }, 'gpt-5');
		expect(t.result()).toEqual([]);
	});
});

describe('summarizeTokenSpeed', () => {
	it('computes token-weighted averages', () => {
		const summary = summarizeTokenSpeed(
			[
				{
					agentType: 'claude-code',
					buckets: [
						bucket({ calls: 1, inputTokens: 1000, outputTokens: 100, durationMs: 1000 }),
						bucket({
							startMs: BASE + 3_600_000,
							calls: 1,
							inputTokens: 0,
							outputTokens: 900,
							durationMs: 9000,
						}),
					],
				},
			],
			OPTIONS
		);

		// 1,000 output over 10s, not the mean of 100 and 100 tok/s.
		expect(summary.overall.avgOutputTps).toBeCloseTo(100);
		expect(summary.overall.avgInputTps).toBeCloseTo(100);
		expect(summary.overall.avgTotalTps).toBeCloseTo(200);
		expect(summary.overall.calls).toBe(2);
	});

	it('reads peaks from model-hours merged across sessions, gated on call time', () => {
		const half = TOKEN_SPEED_PEAK_MIN_BUCKET_MS / 2;
		const summary = summarizeTokenSpeed(
			[
				// Two sessions share one model-hour; neither alone has enough call
				// time to set a peak, together they do.
				{
					agentType: 'claude-code',
					buckets: [bucket({ outputTokens: 30_000, inputTokens: 60_000, durationMs: half })],
				},
				{
					agentType: 'claude-code',
					buckets: [bucket({ outputTokens: 30_000, inputTokens: 60_000, durationMs: half })],
				},
				// A faster hour that is too short to trust.
				{
					agentType: 'claude-code',
					buckets: [
						bucket({ startMs: BASE + 3_600_000, outputTokens: 50_000, durationMs: 10_000 }),
					],
				},
			],
			OPTIONS
		);

		const secs = TOKEN_SPEED_PEAK_MIN_BUCKET_MS / 1000;
		expect(summary.overall.peakOutputTps).toBeCloseTo(60_000 / secs);
		expect(summary.overall.peakInputTps).toBeCloseTo(120_000 / secs);
		expect(summary.overall.peakTotalTps).toBeCloseTo(180_000 / secs);
		expect(summary.overall.peakOutputAtMs).toBe(BASE);
		expect(summary.overall.peakOutputModel).toBe('claude-opus-5-5');
	});

	it('reports no peak when no hour has enough call time', () => {
		const summary = summarizeTokenSpeed(
			[{ agentType: 'codex', buckets: [bucket({ outputTokens: 100, durationMs: 2000 })] }],
			OPTIONS
		);
		expect(summary.overall.peakOutputTps).toBe(0);
		expect(summary.overall.peakOutputAtMs).toBeUndefined();
		expect(summary.overall.avgOutputTps).toBeCloseTo(50);
	});

	it('groups by provider and model, labeling each, busiest first', () => {
		const summary = summarizeTokenSpeed(
			[
				{
					agentType: 'claude-code',
					buckets: [bucket({ model: 'opus', outputTokens: 500 })],
				},
				{
					agentType: 'codex',
					buckets: [
						bucket({ model: 'gpt', outputTokens: 900 }),
						bucket({ model: '', outputTokens: 10 }),
					],
				},
			],
			OPTIONS
		);

		expect(summary.byAgent.map((g) => [g.key, g.label, g.outputTokens])).toEqual([
			['codex', 'label:codex', 910],
			['claude-code', 'label:claude-code', 500],
		]);
		expect(summary.byModel.map((g) => g.key)).toEqual(['gpt', 'opus', 'unknown']);
		expect(summary.measuredAgents).toEqual(['claude-code', 'codex']);
	});

	it('splits by local hour of day and finds the busiest fleet hour', () => {
		const summary = summarizeTokenSpeed(
			[
				{
					agentType: 'claude-code',
					buckets: [bucket({ inputTokens: 3600, outputTokens: 7200 })],
				},
				{
					agentType: 'codex',
					buckets: [
						bucket({ model: 'gpt', inputTokens: 3600, outputTokens: 0 }),
						bucket({ model: 'gpt', startMs: BASE + 3_600_000, outputTokens: 100 }),
					],
				},
			],
			OPTIONS
		);

		expect(summary.byHourOfDay).toHaveLength(24);
		expect(summary.byHourOfDay[10].calls).toBe(2);
		expect(summary.byHourOfDay[11].calls).toBe(1);
		expect(summary.busiestHour).toEqual({
			startMs: BASE,
			inputTps: 2,
			outputTps: 2,
			totalTps: 4,
		});
	});

	it('keeps only buckets inside the window and aligns timelines by slice', () => {
		const day = 24 * 3_600_000;
		const summary = summarizeTokenSpeed(
			[
				{
					agentType: 'claude-code',
					buckets: [
						bucket({ startMs: BASE - 10 * day, outputTokens: 1 }),
						bucket({ startMs: BASE - day, outputTokens: 100 }),
						bucket({ startMs: BASE, outputTokens: 200 }),
					],
				},
			],
			{ ...OPTIONS, sinceMs: BASE - 3 * day, untilMs: BASE + day }
		);

		expect(summary.granularity).toBe('day');
		expect(summary.timeline.map((p) => p.outputTokens)).toEqual([100, 200]);
		expect(summary.timelineByAgent['claude-code'].map((p) => p.startMs)).toEqual(
			summary.timeline.map((p) => p.startMs)
		);
		expect(summary.timelineByModel['claude-opus-5-5']).toHaveLength(2);
	});

	it('returns an empty summary for no data', () => {
		expect(summarizeTokenSpeed([], OPTIONS)).toEqual({
			...emptyTokenSpeedSummary(),
			granularity: 'hour',
		});
	});
});

describe('granularity helpers', () => {
	it('chooses a readable slice size for the span', () => {
		const day = 24 * 3_600_000;
		expect(tokenSpeedGranularityFor(day)).toBe('hour');
		expect(tokenSpeedGranularityFor(30 * day)).toBe('day');
		expect(tokenSpeedGranularityFor(365 * day)).toBe('week');
		expect(tokenSpeedGranularityFor(800 * day)).toBe('month');
	});

	it('starts weeks on Monday and months on the 1st, in local time', () => {
		const wed = new Date(2026, 9, 14, 15, 30).getTime();
		expect(tokenSpeedSliceStart(wed, 'hour')).toBe(localHourStart(wed));
		expect(new Date(tokenSpeedSliceStart(wed, 'day')).getHours()).toBe(0);
		expect(new Date(tokenSpeedSliceStart(wed, 'week')).getDay()).toBe(1);
		expect(new Date(tokenSpeedSliceStart(wed, 'month')).getDate()).toBe(1);
	});
});
