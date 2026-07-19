import { describe, expect, it } from 'vitest';
import { OmpOutputParser } from '../../../main/parsers/omp-output-parser';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';

/**
 * Captured `omp -p --mode json "Reply with exactly the two characters: ok"` output.
 * Source: local://omp-sample.jsonl (real run on this machine).
 */
const OMP_SAMPLE = `{"type":"session","version":3,"id":"019f053e-8426-7000-8d2a-b62b4fb55545","timestamp":"2026-06-26T18:43:30.984Z","cwd":"C:\\\\Users\\\\example\\\\AppData\\\\Local\\\\Temp\\\\omp-probe"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the two characters: ok"}],"attribution":"user","timestamp":1782499411936}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the two characters: ok"}],"attribution":"user","timestamp":1782499411936}}
{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-opus-4-8","usage":{"input":2,"output":4,"cacheRead":0,"cacheWrite":14443,"totalTokens":14449,"cost":{"input":0.00001,"output":0.0001,"cacheRead":0,"cacheWrite":0.09026875000000001,"total":0.09037875000000001},"cttl":{"ephemeral1h":14443}},"stopReason":"stop","timestamp":1782499414886,"responseId":"msg_01CoMSHtJYk8HJTJPP1KC9Ua","duration":1930,"ttft":1929}}
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0,"partial":{"role":"assistant","content":[{"type":"text","text":"ok"}]}},"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ok","partial":{"role":"assistant","content":[{"type":"text","text":"ok"}]}},"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"ok","partial":{"role":"assistant","content":[{"type":"text","text":"ok"}]}},"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-opus-4-8","usage":{"input":2,"output":4,"cacheRead":0,"cacheWrite":14443,"totalTokens":14449,"cost":{"input":0.00001,"output":0.0001,"cacheRead":0,"cacheWrite":0.09026875000000001,"total":0.09037875000000001}},"stopReason":"stop","timestamp":1782499414886,"responseId":"msg_01CoMSHtJYk8HJTJPP1KC9Ua","duration":1930,"ttft":1929}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":2,"output":4,"totalTokens":14449,"cost":{"total":0.09037875000000001}}},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"Reply with exactly the two characters: ok"}],"attribution":"user","timestamp":1782499411936},{"role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-opus-4-8","usage":{"input":2,"output":4,"totalTokens":14449,"cost":{"total":0.09037875000000001}},"stopReason":"stop"}]}`;

describe('OmpOutputParser', () => {
	const parser = new OmpOutputParser();

	const parseSample = (): ParsedEvent[] =>
		OMP_SAMPLE.split('\n')
			.map((line) => parser.parseJsonLine(line))
			.filter((event): event is ParsedEvent => event !== null);

	it('identifies as the omp agent', () => {
		expect(parser.agentId).toBe('omp');
	});

	it('extracts the resumable session id from the session line', () => {
		const events = parseSample();
		const init = events.find((event) => event.type === 'init');

		expect(init).toBeDefined();
		expect(parser.extractSessionId(init!)).toBe('019f053e-8426-7000-8d2a-b62b4fb55545');
	});

	it('assembles streamed assistant text from text_delta chunks', () => {
		const events = parseSample();
		const streamedText = events
			.filter((event) => event.type === 'text' && event.isPartial && !event.isReasoning)
			.map((event) => event.text || '')
			.join('');

		expect(streamedText).toBe('ok');
	});

	it('extracts usage with token totals and cost from the assistant message_end', () => {
		const events = parseSample();
		const usageEvent = events.find((event) => event.type === 'usage');

		expect(usageEvent).toBeDefined();
		const usage = parser.extractUsage(usageEvent!);
		expect(usage).not.toBeNull();
		expect(usage!.inputTokens).toBe(2);
		expect(usage!.outputTokens).toBe(4);
		expect(usage!.cacheReadTokens).toBe(0);
		expect(usage!.cacheCreationTokens).toBe(14443);

		// omp's totalTokens (14449) is the sum of input + output + cache read + cache write.
		const totalTokens =
			usage!.inputTokens +
			usage!.outputTokens +
			(usage!.cacheReadTokens || 0) +
			(usage!.cacheCreationTokens || 0);
		expect(totalTokens).toBe(14449);

		expect(usage!.costUsd).toBeCloseTo(0.0904, 4);
	});

	it('treats agent_end as the authoritative final result', () => {
		const events = parseSample();
		const finalEvent = events.at(-1);

		expect(finalEvent).toBeDefined();
		expect(parser.isResultMessage(finalEvent!)).toBe(true);
		expect(finalEvent).toMatchObject({ type: 'result', text: 'ok' });
	});

	it('does not emit an empty result when agent_end has an empty messages array', () => {
		const event = parser.parseJsonObject({ type: 'agent_end', messages: [] });

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('does not emit an empty result when agent_end omits the messages array', () => {
		const event = parser.parseJsonObject({ type: 'agent_end' });

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('does not emit a result when agent_end carries only a user message', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
		});

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('does not emit a result when agent_end final assistant message has empty text', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
				{ role: 'assistant', content: [{ type: 'text', text: '' }] },
			],
		});

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('does not emit a result when agent_end final assistant message is whitespace-only', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [{ role: 'assistant', content: [{ type: 'text', text: '   \n\t' }] }],
		});

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('does not emit a result when agent_end final assistant message carries no text block', () => {
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [
				{
					role: 'assistant',
					content: [{ type: 'toolCall', toolName: 'edit', args: {} }],
				},
			],
		});

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});
	it('does not surface a retrying agent_end as a user-facing error', () => {
		const retrying = {
			type: 'agent_end',
			willRetry: true,
			error: 'overloaded: retrying request',
		};

		const event = parser.parseJsonObject(retrying);
		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');

		expect(parser.detectErrorFromParsed(retrying)).toBeNull();
	});

	it('treats a TTSR rule interrupt on message_end as usage, not an error', () => {
		const event = parser.parseJsonObject({
			type: 'message_end',
			message: {
				role: 'assistant',
				errorMessage: 'TTSR matched rule: ts-no-any',
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			},
		});

		expect(event).not.toBeNull();
		expect(event!.type).toBe('usage');
		expect(event!.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
	});

	it('does not report a TTSR rule interrupt via detectErrorFromParsed', () => {
		expect(
			parser.detectErrorFromParsed({
				type: 'message_end',
				message: { role: 'assistant', errorMessage: 'TTSR matched rule: ts-no-return-type' },
			})
		).toBeNull();
	});

	it('does not report a multi-rule TTSR interrupt as an error', () => {
		expect(
			parser.detectErrorFromParsed({
				message: { errorMessage: 'TTSR matched rules: ts-no-any, ts-no-return-type' },
			})
		).toBeNull();
	});

	it('does not emit a TTSR-aborted final message as an agent_end result or error', () => {
		// The agent re-iterates after a TTSR interrupt, so the aborted turn must not
		// be marked as the run's result (which would let the stdout handler drop the
		// self-healed output) nor surface as an error.
		const event = parser.parseJsonObject({
			type: 'agent_end',
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'write some ts' }] },
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'partial' }],
					errorMessage: 'TTSR matched rule: ts-no-any',
				},
			],
		});

		expect(event).not.toBeNull();
		expect(event!.type).toBe('system');
		expect(parser.isResultMessage(event!)).toBe(false);
	});

	it('still surfaces a genuine agent error that is not a TTSR interrupt', () => {
		const genuine = {
			type: 'message_end',
			message: { role: 'assistant', errorMessage: 'invalid api key' },
		};

		expect(parser.parseJsonObject(genuine)!.type).toBe('error');

		const detected = parser.detectErrorFromParsed(genuine);
		expect(detected).not.toBeNull();
		expect(detected!.type).toBe('auth_expired');
	});
});
