/**
 * @file json-emitter.test.ts
 * @description Tests for src/maestro-p/json-emitter.ts - the stream-json
 * emitter that ships init / assistant / user / result envelopes (and the
 * standalone status snapshot) to stdout.
 *
 * Strategy: spy on `process.stdout.write` per the playbook spec, then parse
 * the captured strings back into objects to assert structural contract
 * compliance. Each test resets the spy in beforeEach so emissions don't leak
 * across cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	JsonEmitter,
	type EmitResultOptions,
	type StatusSnapshot,
} from '../../maestro-p/json-emitter';

describe('JsonEmitter', () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let writtenLines: string[];

	beforeEach(() => {
		writtenLines = [];
		writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
			chunk: string | Uint8Array
		) => {
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
			writtenLines.push(text);
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	function parseEmissions(): unknown[] {
		// Each writeLine writes exactly one `JSON.stringify(obj) + '\n'` per call.
		// The spy captures one entry per call, so we parse each entry as a single
		// JSON object (stripping the trailing newline).
		return writtenLines.map((line) => {
			expect(line.endsWith('\n')).toBe(true);
			return JSON.parse(line.slice(0, -1));
		});
	}

	describe('writeLine EPIPE handling', () => {
		it('swallows EPIPE when the stdout reader has gone (no crash)', () => {
			const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
			writeSpy.mockImplementation((() => {
				throw epipe;
			}) as typeof process.stdout.write);
			const emitter = new JsonEmitter();
			// emitInit emits through writeLine; a dead pipe must not crash maestro-p.
			expect(() => emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' })).not.toThrow();
		});

		it('re-throws write errors that are not a dead pipe', () => {
			const boom = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
			writeSpy.mockImplementation((() => {
				throw boom;
			}) as typeof process.stdout.write);
			const emitter = new JsonEmitter();
			expect(() => emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' })).toThrow(
				/disk full/
			);
		});
	});

	describe('emitInit', () => {
		it('writes one system/init envelope with the supplied fields', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({
				sessionId: 'abc-123',
				model: 'claude-opus-4-7',
				cwd: '/Users/pedram/proj',
			});

			const events = parseEmissions();
			expect(events).toEqual([
				{
					type: 'system',
					subtype: 'init',
					session_id: 'abc-123',
					model: 'claude-opus-4-7',
					cwd: '/Users/pedram/proj',
				},
			]);
		});

		it('writes model as null when the caller does not know it yet', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });

			const events = parseEmissions() as Array<Record<string, unknown>>;
			expect(events[0]).toHaveProperty('model', null);
		});

		it('emits the init envelope exactly once (subsequent calls are silent no-ops)', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'first', model: null, cwd: '/cwd' });
			emitter.emitInit({ sessionId: 'second', model: 'opus', cwd: '/cwd' });
			emitter.emitInit({ sessionId: 'third', model: null, cwd: '/cwd' });

			const events = parseEmissions() as Array<Record<string, unknown>>;
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ session_id: 'first' });
		});

		it('throws if called after a final envelope (emitResult)', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			expect(() => emitter.emitInit({ sessionId: 'def', model: null, cwd: '/cwd' })).toThrow(
				/after final envelope/
			);
		});
	});

	describe('emitAssistantMessage', () => {
		it('throws if called before emitInit', () => {
			const emitter = new JsonEmitter();
			expect(() => emitter.emitAssistantMessage({ role: 'assistant' })).toThrow(/before emitInit/);
		});

		it('wraps the supplied message verbatim under { type: "assistant", message }', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });

			const rawMessage = {
				id: 'msg_01',
				role: 'assistant',
				content: [
					{ type: 'text', text: 'hello' },
					{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
				],
				stop_reason: 'end_turn',
				usage: {
					input_tokens: 12,
					output_tokens: 34,
					cache_read_input_tokens: 100,
				},
			};

			emitter.emitAssistantMessage(rawMessage);

			const events = parseEmissions();
			expect(events).toHaveLength(2);
			expect(events[1]).toEqual({ type: 'assistant', message: rawMessage });
		});

		it('does not mutate, clone, or filter the supplied message object', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });

			// A field that would be tempting to strip (e.g., model: '<synthetic>')
			// - the emitter must pass it through; filtering is the runner's job.
			const rawMessage = {
				model: '<synthetic>',
				content: [{ type: 'text', text: 'No response requested.' }],
				stop_reason: null,
				usage: null,
			};
			emitter.emitAssistantMessage(rawMessage);

			const events = parseEmissions() as Array<{ message: unknown }>;
			expect(events[1].message).toEqual(rawMessage);
		});

		it('throws if called after emitResult', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			expect(() => emitter.emitAssistantMessage({ role: 'assistant' })).toThrow(
				/after final envelope/
			);
		});

		it('throws if called after emitStatus', () => {
			const emitter = new JsonEmitter();
			const snapshot = makeSnapshot();
			emitter.emitStatus(snapshot);

			expect(() => emitter.emitAssistantMessage({ role: 'assistant' })).toThrow(
				/after final envelope/
			);
		});
	});

	describe('emitUserMessage', () => {
		it('throws if called before emitInit', () => {
			const emitter = new JsonEmitter();
			expect(() => emitter.emitUserMessage({ role: 'user' })).toThrow(/before emitInit/);
		});

		it('wraps the supplied message verbatim under { type: "user", message }', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });

			const rawMessage = {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'tu_1',
						content: 'file1.txt\nfile2.txt',
					},
				],
			};
			emitter.emitUserMessage(rawMessage);

			const events = parseEmissions();
			expect(events[1]).toEqual({ type: 'user', message: rawMessage });
		});

		it('throws if called after emitResult', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			expect(() => emitter.emitUserMessage({ role: 'user' })).toThrow(/after final envelope/);
		});
	});

	describe('emitResult', () => {
		it('throws if called before emitInit', () => {
			const emitter = new JsonEmitter();
			expect(() =>
				emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false })
			).toThrow(/before emitInit/);
		});

		it('writes the minimum success envelope when no optional fields are supplied', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 1234, isError: false });

			const events = parseEmissions();
			expect(events[1]).toEqual({
				type: 'result',
				subtype: 'success',
				session_id: 'abc',
				duration_ms: 1234,
				is_error: false,
			});
		});

		it('omits optional result / usage / modelUsage / total_cost_usd / error when not supplied', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			const events = parseEmissions() as Array<Record<string, unknown>>;
			const resultEvent = events[1];
			expect(resultEvent).not.toHaveProperty('result');
			expect(resultEvent).not.toHaveProperty('usage');
			expect(resultEvent).not.toHaveProperty('modelUsage');
			expect(resultEvent).not.toHaveProperty('total_cost_usd');
			expect(resultEvent).not.toHaveProperty('error');
		});

		it('includes optional fields when supplied', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: 'opus', cwd: '/cwd' });

			const opts: EmitResultOptions = {
				sessionId: 'abc',
				durationMs: 5678,
				isError: false,
				result: 'The answer is 4.',
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 200,
					cache_creation_input_tokens: 0,
				},
				modelUsage: {
					'claude-opus-4-7': { inputTokens: 100, outputTokens: 50 },
				},
				totalCostUsd: 0.0042,
			};
			emitter.emitResult(opts);

			const events = parseEmissions() as Array<Record<string, unknown>>;
			expect(events[1]).toEqual({
				type: 'result',
				subtype: 'success',
				session_id: 'abc',
				duration_ms: 5678,
				is_error: false,
				result: 'The answer is 4.',
				usage: opts.usage,
				modelUsage: opts.modelUsage,
				total_cost_usd: 0.0042,
			});
		});

		it('uses subtype "error_during_execution" and includes error string when isError is true', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({
				sessionId: 'abc',
				durationMs: 300_000,
				isError: true,
				error: 'timeout',
			});

			const events = parseEmissions();
			expect(events[1]).toEqual({
				type: 'result',
				subtype: 'error_during_execution',
				session_id: 'abc',
				duration_ms: 300_000,
				is_error: true,
				error: 'timeout',
			});
		});

		it('preserves error variant strings the runner uses (limit, tui_exited)', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({
				sessionId: 'abc',
				durationMs: 1500,
				isError: true,
				error: 'limit',
			});

			const events = parseEmissions() as Array<Record<string, unknown>>;
			expect(events[1]).toMatchObject({ is_error: true, error: 'limit' });
		});

		it('throws if called a second time', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			expect(() =>
				emitter.emitResult({ sessionId: 'abc', durationMs: 200, isError: false })
			).toThrow(/after final envelope/);
		});

		it('includes total_cost_usd === 0 when explicitly supplied as 0', () => {
			// Guard against `if (totalCostUsd)` falsy bugs: a free turn has a real
			// cost of 0 and consumers should see it, not see the field omitted.
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({
				sessionId: 'abc',
				durationMs: 100,
				isError: false,
				totalCostUsd: 0,
			});

			const events = parseEmissions() as Array<Record<string, unknown>>;
			expect(events[1]).toHaveProperty('total_cost_usd', 0);
		});
	});

	describe('emitStatus', () => {
		it('writes the supplied snapshot verbatim to stdout', () => {
			const emitter = new JsonEmitter();
			const snapshot = makeSnapshot();
			emitter.emitStatus(snapshot);

			const events = parseEmissions();
			expect(events).toEqual([snapshot]);
		});

		it('does not require emitInit (standalone single-line protocol)', () => {
			const emitter = new JsonEmitter();
			expect(() => emitter.emitStatus(makeSnapshot())).not.toThrow();
		});

		it('throws if called after emitResult', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			expect(() => emitter.emitStatus(makeSnapshot())).toThrow(/after final envelope/);
		});

		it('throws if called twice', () => {
			const emitter = new JsonEmitter();
			emitter.emitStatus(makeSnapshot());

			expect(() => emitter.emitStatus(makeSnapshot())).toThrow(/after final envelope/);
		});
	});

	describe('wire format', () => {
		it('writes each event as exactly one stdout.write call (one JSON object + trailing newline)', () => {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', model: null, cwd: '/cwd' });
			emitter.emitAssistantMessage({ role: 'assistant', content: 'hi' });
			emitter.emitUserMessage({ role: 'user', content: [{ type: 'tool_result' }] });
			emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });

			expect(writtenLines).toHaveLength(4);
			for (const line of writtenLines) {
				expect(line.endsWith('\n')).toBe(true);
				// Exactly one \n at the very end - no embedded newlines splitting
				// what should be a single JSONL record across multiple lines.
				expect(line.indexOf('\n')).toBe(line.length - 1);
				// Parses as a single JSON value.
				expect(() => JSON.parse(line)).not.toThrow();
			}
		});
	});
});

function makeSnapshot(): StatusSnapshot {
	return {
		type: 'status',
		config_dir: '/Users/pedram/.claude',
		session: { percent: 23, resets_at: '2026-05-15T18:00:00.000Z' },
		week_all_models: { percent: 58, resets_at: '2026-05-17T18:00:00.000Z' },
		week_sonnet_only: { percent: 0, resets_at: '2026-05-17T18:00:00.000Z' },
	};
}
