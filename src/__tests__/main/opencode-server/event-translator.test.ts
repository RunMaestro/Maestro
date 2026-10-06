import { describe, it, expect } from 'vitest';
import { OpencodeEventTranslator } from '../../../main/opencode-server/event-translator';
import { OpenCodeOutputParser } from '../../../main/parsers/opencode-output-parser';
import type { Event, Part } from '@opencode-ai/sdk';

const SID = 'ses_abc123';

/** Build a `message.part.updated` event for the given part. */
function partEvent(part: Partial<Part> & { type: Part['type'] }): Event {
	return {
		type: 'message.part.updated',
		properties: {
			part: { id: 'prt_1', sessionID: SID, messageID: 'msg_1', ...part } as Part,
		},
	} as Event;
}

describe('OpencodeEventTranslator', () => {
	describe('session filtering', () => {
		it('ignores parts from other sessions on the shared server', () => {
			const t = new OpencodeEventTranslator(SID);
			const other = partEvent({ type: 'step-start' });
			(other.properties as { part: Part }).part.sessionID = 'ses_other';
			expect(t.handle(other)).toEqual({ lines: [], idle: false, errored: false });
		});

		it('ignores session.idle for a different session', () => {
			const t = new OpencodeEventTranslator(SID);
			const evt = { type: 'session.idle', properties: { sessionID: 'ses_other' } } as Event;
			expect(t.handle(evt).idle).toBe(false);
		});
	});

	describe('part translation -> CLI JSONL', () => {
		it('translates step-start to a step_start line', () => {
			const t = new OpencodeEventTranslator(SID);
			const { lines } = t.handle(partEvent({ type: 'step-start' }));
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual({
				type: 'step_start',
				sessionID: SID,
				part: { type: 'step-start' },
			});
		});

		it('translates a completed text part exactly once', () => {
			const t = new OpencodeEventTranslator(SID);
			// Streaming update (no time.end) is buffered, not emitted.
			const streaming = t.handle(partEvent({ type: 'text', text: 'Hel', time: { start: 1 } }));
			expect(streaming.lines).toEqual([]);
			// Completed update flushes the full text once.
			const done = t.handle(
				partEvent({ type: 'text', text: 'Hello world', time: { start: 1, end: 2 } })
			);
			expect(done.lines).toHaveLength(1);
			expect(JSON.parse(done.lines[0])).toMatchObject({
				type: 'text',
				sessionID: SID,
				part: { type: 'text', text: 'Hello world' },
			});
			// A duplicate completed update for the same part id is not re-emitted.
			const dup = t.handle(
				partEvent({ type: 'text', text: 'Hello world', time: { start: 1, end: 2 } })
			);
			expect(dup.lines).toEqual([]);
		});

		it('flushes buffered streaming text on session.idle if never completed', () => {
			const t = new OpencodeEventTranslator(SID);
			t.handle(partEvent({ type: 'text', text: 'partial answer', time: { start: 1 } }));
			const idle = t.handle({
				type: 'session.idle',
				properties: { sessionID: SID },
			} as Event);
			expect(idle.idle).toBe(true);
			expect(idle.lines).toHaveLength(1);
			expect(JSON.parse(idle.lines[0])).toMatchObject({
				type: 'text',
				part: { text: 'partial answer' },
			});
		});

		it('translates tool parts (skipping pending) to tool_use lines', () => {
			const t = new OpencodeEventTranslator(SID);
			const pending = t.handle(
				partEvent({
					type: 'tool',
					tool: 'read',
					callID: 'call_1',
					state: { status: 'pending', input: {}, raw: '' },
				} as Partial<Part> & { type: 'tool' })
			);
			expect(pending.lines).toEqual([]);

			const completed = t.handle(
				partEvent({
					type: 'tool',
					tool: 'read',
					callID: 'call_1',
					state: {
						status: 'completed',
						input: { path: '/a.ts' },
						output: 'contents',
						title: 'read /a.ts',
						metadata: {},
						time: { start: 1, end: 2 },
					},
				} as Partial<Part> & { type: 'tool' })
			);
			expect(completed.lines).toHaveLength(1);
			expect(JSON.parse(completed.lines[0])).toMatchObject({
				type: 'tool_use',
				sessionID: SID,
				part: { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed' } },
			});
		});

		it('translates step-finish (with tokens/cost) to a step_finish line', () => {
			const t = new OpencodeEventTranslator(SID);
			const { lines } = t.handle(
				partEvent({
					type: 'step-finish',
					reason: 'stop',
					cost: 0.002,
					tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
				} as Partial<Part> & { type: 'step-finish' })
			);
			expect(JSON.parse(lines[0])).toEqual({
				type: 'step_finish',
				sessionID: SID,
				part: {
					type: 'step-finish',
					reason: 'stop',
					cost: 0.002,
					tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
				},
			});
		});

		it('skips reasoning/other parts with no CLI equivalent', () => {
			const t = new OpencodeEventTranslator(SID);
			expect(
				t.handle(
					partEvent({ type: 'reasoning', text: 'thinking...' } as Partial<Part> & {
						type: 'reasoning';
					})
				).lines
			).toEqual([]);
		});
	});

	describe('errors', () => {
		it('translates session.error into a parseable error line', () => {
			const t = new OpencodeEventTranslator(SID);
			const res = t.handle({
				type: 'session.error',
				properties: {
					sessionID: SID,
					error: { name: 'APIError', data: { message: 'rate limited', isRetryable: true } },
				},
			} as Event);
			expect(res.errored).toBe(true);
			expect(JSON.parse(res.lines[0])).toMatchObject({
				type: 'error',
				error: { name: 'APIError', data: { message: 'rate limited' } },
			});
		});

		it('surfaces a payload-less session error as a recognizable error line', () => {
			const t = new OpencodeEventTranslator(SID);
			const res = t.handle({
				type: 'session.error',
				properties: { sessionID: SID },
			} as Event);
			expect(res.errored).toBe(true);
			expect(JSON.parse(res.lines[0]).type).toBe('error');
		});

		it('drops a session.error scoped to a different session', () => {
			const t = new OpencodeEventTranslator(SID);
			const res = t.handle({
				type: 'session.error',
				properties: {
					sessionID: 'ses_other',
					error: { name: 'APIError', data: { message: 'nope' } },
				},
			} as Event);
			expect(res).toEqual({ lines: [], idle: false, errored: false });
		});

		it('drops a session-less error instead of aborting this turn', () => {
			// On the shared server a session-less error is broadcast to every
			// subscriber; treating it as ours would kill unrelated concurrent turns.
			const t = new OpencodeEventTranslator(SID);
			const res = t.handle({
				type: 'session.error',
				properties: { error: { name: 'UnknownError', data: { message: 'global' } } },
			} as Event);
			expect(res).toEqual({ lines: [], idle: false, errored: false });
		});
	});

	describe('round-trip fidelity through OpenCodeOutputParser', () => {
		// The migration's core premise: translated lines parse identically to real
		// CLI output. Feed a full turn through the translator, then the parser.
		it('parses a full turn into the expected normalized events', () => {
			const t = new OpencodeEventTranslator(SID);
			const parser = new OpenCodeOutputParser();

			const events: Event[] = [
				partEvent({ type: 'step-start' }),
				partEvent({
					type: 'tool',
					tool: 'read',
					callID: 'c1',
					state: {
						status: 'completed',
						input: { path: '/x.ts' },
						output: 'ok',
						title: 't',
						metadata: {},
						time: { start: 1, end: 2 },
					},
				} as Partial<Part> & { type: 'tool' }),
				partEvent({ type: 'text', text: 'Final answer', time: { start: 3, end: 4 } }),
				partEvent({
					type: 'step-finish',
					reason: 'stop',
					cost: 0.01,
					tokens: { input: 200, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
				} as Partial<Part> & { type: 'step-finish' }),
				{ type: 'session.idle', properties: { sessionID: SID } } as Event,
			];

			const parsed = events
				.flatMap((e) => t.handle(e).lines)
				.map((line) => parser.parseJsonLine(line));

			const types = parsed.map((p) => p?.type);
			expect(types).toEqual(['init', 'tool_use', 'result', 'system']);

			const result = parsed.find((p) => p?.type === 'result');
			expect(result?.text).toBe('Final answer');

			const system = parsed.find((p) => p?.type === 'system');
			expect(system?.usage?.inputTokens).toBe(200);
			expect(system?.usage?.outputTokens).toBe(80);
			expect(system?.usage?.costUsd).toBe(0.01);
		});
	});
});
