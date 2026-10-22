/**
 * `TurnCapture`: what a turn's parsed events add up to.
 *
 * The parser here is a stub that hands back exactly what each test gives it,
 * so every case is about the capture's own rules and none is about how a
 * provider writes its stream.
 */
import { describe, it, expect, vi } from 'vitest';

import { TurnCapture, usageReportingFor } from '../../../../shared/maestro-lib/run/turn-capture';
import type {
	AgentOutputParser,
	ParsedEvent,
} from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import type { AgentError } from '../../../../shared/types';

type Usage = NonNullable<ParsedEvent['usage']>;

function stubParser(overrides: Partial<AgentOutputParser> = {}): AgentOutputParser {
	return {
		agentId: 'opencode',
		parseJsonLine: () => null,
		parseJsonObject: () => null,
		isResultMessage: (event) => event.type === 'result',
		extractSessionId: (event) => event.sessionId ?? null,
		extractUsage: (event) => event.usage ?? null,
		extractSlashCommands: () => null,
		detectErrorFromLine: () => null,
		detectErrorFromParsed: () => null,
		detectErrorFromExit: () => null,
		...overrides,
	} as AgentOutputParser;
}

function capture(agentId: string, events: ParsedEvent[], parser = stubParser()): TurnCapture {
	const turn = new TurnCapture(agentId, parser);
	for (const event of events) turn.handleEvent(event);
	return turn;
}

const usage = (inputTokens: number, outputTokens: number, costUsd = 0): Usage => ({
	inputTokens,
	outputTokens,
	costUsd,
});

describe('usageReportingFor', () => {
	it('names how each provider reports usage', () => {
		expect(usageReportingFor('codex')).toBe('running-total');
		expect(usageReportingFor('claude-code')).toBe('turn-total');
		expect(usageReportingFor('opencode')).toBe('per-step');
		// Sets the combined-context flag, but reports per-step values.
		expect(usageReportingFor('copilot-cli')).toBe('per-step');
	});
});

describe('TurnCapture session id', () => {
	it('keeps the first id announced', () => {
		const turn = capture('opencode', [
			{ type: 'init', sessionId: 'first' },
			{ type: 'text', sessionId: 'second', text: 'hi' },
		]);

		expect(turn.sessionId).toBe('first');
	});

	it('takes an id that only arrives on the final event', () => {
		const turn = capture('copilot-cli', [
			{ type: 'text', text: 'hi', isPartial: true },
			{ type: 'result', sessionId: 'late', text: 'hi' },
		]);

		expect(turn.sessionId).toBe('late');
	});

	it('has none when the provider never announced one', () => {
		expect(capture('opencode', [{ type: 'text', text: 'hi' }]).sessionId).toBeUndefined();
	});
});

describe('TurnCapture answer', () => {
	it('is the result text', () => {
		const turn = capture('opencode', [
			{ type: 'text', text: 'thinking out loud', isPartial: true },
			{ type: 'result', text: 'Paris.' },
		]);

		expect(turn.answerText).toBe('Paris.');
		expect(turn.resultMessageSeen).toBe(true);
	});

	it('joins several result events with a newline', () => {
		const turn = capture('opencode', [
			{ type: 'result', text: 'one' },
			{ type: 'result', text: 'two' },
		]);

		expect(turn.answerText).toBe('one\ntwo');
	});

	it('falls back to the streamed text when the result carries none', () => {
		// Token-sized deltas carry their own whitespace, so they concatenate as-is.
		const turn = capture('grok', [
			{ type: 'text', text: 'The capital', isPartial: true },
			{ type: 'text', text: ' of France', isPartial: true },
			{ type: 'text', text: ' is Paris.', isPartial: true },
			{ type: 'result' },
		]);

		expect(turn.answerText).toBe('The capital of France is Paris.');
		expect(turn.resultMessageSeen).toBe(true);
	});

	it('leaves reasoning out of the answer', () => {
		const turn = capture('opencode', [
			{ type: 'text', text: 'Let me think.', isPartial: true, isReasoning: true },
			{ type: 'text', text: 'Paris.', isPartial: true },
		]);

		expect(turn.answerText).toBe('Paris.');
	});

	it('does not count text that is not a streamed delta', () => {
		const turn = capture('opencode', [{ type: 'text', text: 'a complete message' }]);

		expect(turn.answerText).toBeUndefined();
	});

	it('records that the provider finished even when it said nothing', () => {
		const turn = capture('opencode', [{ type: 'result' }]);

		expect(turn.resultMessageSeen).toBe(true);
		expect(turn.answerText).toBeUndefined();
	});
});

describe('TurnCapture usage', () => {
	it('sums per-step usage', () => {
		const turn = capture('opencode', [
			{ type: 'usage', usage: usage(100, 10, 0.01) },
			{ type: 'usage', usage: usage(50, 5, 0.02) },
		]);

		expect(turn.usage).toMatchObject({ inputTokens: 150, outputTokens: 15 });
		expect(turn.usage?.totalCostUsd).toBeCloseTo(0.03);
	});

	it('keeps only the last report for a provider whose result carries the whole turn', () => {
		// Summing would count the per-call usage again on top of the turn total.
		const turn = capture('claude-code', [
			{ type: 'text', usage: usage(100, 10) },
			{ type: 'result', usage: usage(120, 40, 0.05) },
		]);

		expect(turn.usage).toMatchObject({ inputTokens: 120, outputTokens: 40, totalCostUsd: 0.05 });
	});

	it('turns a running session total into per-event deltas before summing', () => {
		// Each event repeats everything before it. Summed as-is, three events of
		// 100, 250 and 400 would report 750 for a session that used 400.
		const turn = capture('codex', [
			{ type: 'usage', usage: usage(100, 10) },
			{ type: 'usage', usage: usage(250, 30) },
			{ type: 'usage', usage: usage(400, 45) },
		]);

		expect(turn.usage).toMatchObject({ inputTokens: 400, outputTokens: 45 });
	});

	it('keeps the largest context window rather than adding them up', () => {
		const turn = capture('opencode', [
			{ type: 'usage', usage: { ...usage(1, 1), contextWindow: 128_000 } },
			{ type: 'usage', usage: { ...usage(1, 1), contextWindow: 200_000 } },
		]);

		expect(turn.usage?.contextWindow).toBe(200_000);
	});

	it('has none when the provider reported none', () => {
		expect(capture('opencode', [{ type: 'result', text: 'hi' }]).usage).toBeUndefined();
	});

	it('keeps the reported window, its model and the occupancy snapshot when summing (#1669)', () => {
		const occupancy = { inputTokens: 900, outputTokens: 20 };
		const turn = capture('opencode', [
			{
				type: 'usage',
				usage: {
					...usage(100, 10),
					contextWindow: 200_000,
					contextWindowReported: true,
					model: 'model-a',
					absoluteUsage: occupancy,
				},
			},
			{ type: 'usage', usage: usage(50, 5) },
		]);

		expect(turn.usage).toMatchObject({
			inputTokens: 150,
			contextWindowResolved: true,
			contextWindowModel: 'model-a',
			absoluteUsage: occupancy,
		});
	});

	it('keeps the occupancy snapshot when a later whole-turn report carries none (#1669)', () => {
		const occupancy = { inputTokens: 900, outputTokens: 20 };
		const turn = capture('claude-code', [
			{
				type: 'text',
				usage: {
					...usage(100, 10),
					contextWindow: 200_000,
					contextWindowReported: true,
					absoluteUsage: occupancy,
				},
			},
			{ type: 'result', usage: usage(120, 40, 0.05) },
		]);

		expect(turn.usage).toMatchObject({
			inputTokens: 120,
			outputTokens: 40,
			contextWindowResolved: true,
			absoluteUsage: occupancy,
		});
	});
});

describe('TurnCapture errors', () => {
	const failure: AgentError = {
		type: 'auth_expired',
		message: 'Not logged in',
		recoverable: false,
		agentId: 'claude-code',
		timestamp: 1,
	};

	it('keeps the text of the first error event', () => {
		const turn = capture('opencode', [
			{ type: 'error', text: 'first' },
			{ type: 'error', text: 'second' },
		]);

		expect(turn.errorText).toBe('first');
	});

	it('classifies a failure the provider reported in its own stream', () => {
		const raw = { type: 'result', is_error: true };
		const parser = stubParser({
			detectErrorFromParsed: (parsed) => (parsed === raw ? failure : null),
		});

		const turn = capture('claude-code', [{ type: 'result', raw }], parser);

		expect(turn.inBandError).toBe(failure);
	});

	it('skips an in-turn error notice the provider may retry past', () => {
		const notice = { type: 'system', subtype: 'api_error' };
		const parser = stubParser({
			isProvisionalErrorNotice: (parsed) => parsed === notice,
			detectErrorFromParsed: () => failure,
		});

		const turn = capture('claude-code', [{ type: 'system', raw: notice }], parser);

		expect(turn.inBandError).toBeUndefined();
	});

	it('leaves the classifier alone for a caller that settles on error text', () => {
		const detectErrorFromParsed = vi.fn(() => failure);
		const turn = new TurnCapture('opencode', stubParser({ detectErrorFromParsed }), {
			classifyInBandErrors: false,
		});

		turn.handleEvent({ type: 'error', text: 'boom' });

		expect(detectErrorFromParsed).not.toHaveBeenCalled();
		expect(turn.inBandError).toBeUndefined();
		expect(turn.errorText).toBe('boom');
	});

	it('keeps the first classified failure', () => {
		const later: AgentError = { ...failure, type: 'rate_limited', message: 'Slow down' };
		const failures = [failure, later];
		const parser = stubParser({ detectErrorFromParsed: () => failures.shift() ?? null });

		const turn = capture('claude-code', [{ type: 'system' }, { type: 'system' }], parser);

		expect(turn.inBandError).toBe(failure);
	});
});
