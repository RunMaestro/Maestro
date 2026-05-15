/**
 * @file json-emitter.test.ts
 * @description Tests for the maestro-p stream-json emitter.
 *
 * Covers:
 * - Each emit method produces exactly one JSON object per call, terminated
 *   with `\n`, matching the playbook's documented stream-json subset.
 * - emitInit is a no-op on duplicate calls (race-resolution friendly).
 * - State guards throw on misuse (e.g., assistant text before init,
 *   mixing status mode with run-mode events, double result).
 * - Optional fields (model, error) are omitted when undefined, never
 *   serialized as null.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JsonEmitter, type StatusSnapshot } from '../../maestro-p/json-emitter';

// Minimal NodeJS.WritableStream-shaped sink. Only `write` is exercised by the
// emitter; the other Writable methods are unused here. Returning `true` matches
// the real signature (no backpressure since we never queue).
class CapturingStream {
	public writes: string[] = [];

	write(chunk: string | Uint8Array): boolean {
		this.writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}
}

function makeEmitter(): { emitter: JsonEmitter; sink: CapturingStream } {
	const sink = new CapturingStream();
	// Cast: CapturingStream implements only the `write` slice we need. Vitest
	// + ts-node would otherwise demand the full Writable surface.
	const emitter = new JsonEmitter(sink as unknown as NodeJS.WritableStream);
	return { emitter, sink };
}

// Parse the single JSON object on the most recent write line.
function lastParsed(sink: CapturingStream): Record<string, unknown> {
	const line = sink.writes[sink.writes.length - 1];
	expect(line.endsWith('\n')).toBe(true);
	return JSON.parse(line.trimEnd());
}

describe('JsonEmitter — emitInit', () => {
	it('writes a system/init object with session_id, cwd, and model when provided', () => {
		const { emitter, sink } = makeEmitter();
		emitter.emitInit({
			sessionId: 'abc-123',
			model: 'claude-sonnet-4-5',
			cwd: '/tmp/project',
		});

		expect(sink.writes).toHaveLength(1);
		expect(lastParsed(sink)).toEqual({
			type: 'system',
			subtype: 'init',
			session_id: 'abc-123',
			model: 'claude-sonnet-4-5',
			cwd: '/tmp/project',
		});
	});

	it('omits the model field when not provided (rather than emitting null)', () => {
		const { emitter, sink } = makeEmitter();
		emitter.emitInit({ sessionId: 'abc-123', cwd: '/tmp/project' });

		const parsed = lastParsed(sink);
		expect(parsed).not.toHaveProperty('model');
		expect(parsed).toEqual({
			type: 'system',
			subtype: 'init',
			session_id: 'abc-123',
			cwd: '/tmp/project',
		});
	});

	it('terminates the output with a single newline', () => {
		const { emitter, sink } = makeEmitter();
		emitter.emitInit({ sessionId: 'abc-123', cwd: '/tmp/project' });

		expect(sink.writes[0]).toMatch(/\n$/);
		// Exactly one newline, not two.
		expect(sink.writes[0].split('\n')).toHaveLength(2);
	});

	it('is a no-op on duplicate calls (idempotent for race-resolution)', () => {
		const { emitter, sink } = makeEmitter();
		emitter.emitInit({ sessionId: 'unknown', cwd: '/tmp/project' });
		emitter.emitInit({ sessionId: 'real-id', cwd: '/tmp/project' });

		expect(sink.writes).toHaveLength(1);
		// First call wins; the second is silently dropped.
		expect(lastParsed(sink).session_id).toBe('unknown');
	});
});

describe('JsonEmitter — emitResult', () => {
	let emitter: JsonEmitter;
	let sink: CapturingStream;

	beforeEach(() => {
		({ emitter, sink } = makeEmitter());
		emitter.emitInit({ sessionId: 'abc-123', cwd: '/tmp' });
		sink.writes.length = 0;
	});

	it('writes a result/success object on a normal completion', () => {
		emitter.emitResult({ sessionId: 'abc-123', durationMs: 4200, isError: false });

		expect(lastParsed(sink)).toEqual({
			type: 'result',
			subtype: 'success',
			session_id: 'abc-123',
			duration_ms: 4200,
			is_error: false,
		});
	});

	it('writes is_error: true with an error field when the error reason is provided', () => {
		emitter.emitResult({
			sessionId: 'abc-123',
			durationMs: 12000,
			isError: true,
			error: 'timeout',
		});

		expect(lastParsed(sink)).toMatchObject({
			type: 'result',
			session_id: 'abc-123',
			duration_ms: 12000,
			is_error: true,
			error: 'timeout',
		});
	});

	it('omits the error field when not provided, even if isError is true', () => {
		emitter.emitResult({ sessionId: 'abc-123', durationMs: 5000, isError: true });

		const parsed = lastParsed(sink);
		expect(parsed).not.toHaveProperty('error');
		expect(parsed.is_error).toBe(true);
	});

	it('throws when called before init', () => {
		const fresh = makeEmitter();
		expect(() =>
			fresh.emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false })
		).toThrow(/before init/);
	});

	it('throws when called twice', () => {
		emitter.emitResult({ sessionId: 'abc-123', durationMs: 1000, isError: false });
		expect(() =>
			emitter.emitResult({ sessionId: 'abc-123', durationMs: 1000, isError: false })
		).toThrow(/twice/);
	});

	it('includes result/usage/modelUsage/total_cost_usd when provided', () => {
		emitter.emitResult({
			sessionId: 'abc-123',
			durationMs: 4200,
			isError: false,
			result: 'Final answer.',
			usage: { input_tokens: 100, output_tokens: 5 },
			modelUsage: { 'claude-opus': { inputTokens: 100, outputTokens: 5 } },
			totalCostUsd: 0.0023,
		});

		expect(lastParsed(sink)).toMatchObject({
			type: 'result',
			subtype: 'success',
			session_id: 'abc-123',
			duration_ms: 4200,
			is_error: false,
			result: 'Final answer.',
			usage: { input_tokens: 100, output_tokens: 5 },
			modelUsage: { 'claude-opus': { inputTokens: 100, outputTokens: 5 } },
			total_cost_usd: 0.0023,
		});
	});

	it('omits the optional fields when not provided', () => {
		emitter.emitResult({ sessionId: 'abc-123', durationMs: 1000, isError: false });
		const parsed = lastParsed(sink);
		expect(parsed).not.toHaveProperty('result');
		expect(parsed).not.toHaveProperty('usage');
		expect(parsed).not.toHaveProperty('modelUsage');
		expect(parsed).not.toHaveProperty('total_cost_usd');
	});
});

describe('JsonEmitter — emitAssistantMessage (jsonl pass-through)', () => {
	let emitter: JsonEmitter;
	let sink: CapturingStream;

	beforeEach(() => {
		({ emitter, sink } = makeEmitter());
		emitter.emitInit({ sessionId: 'abc-123', cwd: '/tmp' });
		sink.writes.length = 0;
	});

	it('forwards the message object verbatim under a type=assistant envelope', () => {
		const message = {
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Hi.' },
				{ type: 'tool_use', name: 'Bash', id: 'toolu_x', input: { cmd: 'ls' } },
			],
			stop_reason: 'tool_use',
			usage: { input_tokens: 50, output_tokens: 10 },
		};
		emitter.emitAssistantMessage(message);

		expect(lastParsed(sink)).toEqual({ type: 'assistant', message });
	});

	it('throws when called before init', () => {
		const fresh = makeEmitter();
		expect(() => fresh.emitter.emitAssistantMessage({ role: 'assistant', content: [] })).toThrow(
			/before init/
		);
	});

	it('throws when called after result', () => {
		emitter.emitResult({ sessionId: 'abc-123', durationMs: 100, isError: false });
		expect(() => emitter.emitAssistantMessage({ role: 'assistant', content: [] })).toThrow(
			/after result/
		);
	});
});

describe('JsonEmitter — emitUserMessage (jsonl pass-through)', () => {
	let emitter: JsonEmitter;
	let sink: CapturingStream;

	beforeEach(() => {
		({ emitter, sink } = makeEmitter());
		emitter.emitInit({ sessionId: 'abc-123', cwd: '/tmp' });
		sink.writes.length = 0;
	});

	it('forwards the message object verbatim under a type=user envelope', () => {
		const message = {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_x',
					content: 'file contents here',
				},
			],
		};
		emitter.emitUserMessage(message);
		expect(lastParsed(sink)).toEqual({ type: 'user', message });
	});

	it('throws when called before init', () => {
		const fresh = makeEmitter();
		expect(() => fresh.emitter.emitUserMessage({ role: 'user', content: [] })).toThrow(
			/before init/
		);
	});
});

describe('JsonEmitter — emitStatus', () => {
	const snapshot: StatusSnapshot = {
		type: 'status',
		config_dir: '/Users/test/.claude',
		session: { percent: 23, resets_at: '2026-05-13T23:00:00.000Z' },
		week_all_models: { percent: 58, resets_at: '2026-05-19T23:00:00.000Z' },
		week_sonnet_only: { percent: 0, resets_at: '2026-05-19T23:00:00.000Z' },
	};

	it('writes the snapshot verbatim as a single JSON line', () => {
		const { emitter, sink } = makeEmitter();
		emitter.emitStatus(snapshot);

		expect(sink.writes).toHaveLength(1);
		expect(lastParsed(sink)).toEqual(snapshot);
	});

	it('throws when called after init (mode mix-up)', () => {
		const { emitter } = makeEmitter();
		emitter.emitInit({ sessionId: 'abc', cwd: '/tmp' });
		expect(() => emitter.emitStatus(snapshot)).toThrow(/alongside run-mode/);
	});

	it('throws when called after result (mode mix-up)', () => {
		const { emitter } = makeEmitter();
		emitter.emitInit({ sessionId: 'abc', cwd: '/tmp' });
		emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false });
		expect(() => emitter.emitStatus(snapshot)).toThrow(/alongside run-mode/);
	});

	it('throws when called twice', () => {
		const { emitter } = makeEmitter();
		emitter.emitStatus(snapshot);
		expect(() => emitter.emitStatus(snapshot)).toThrow(/twice/);
	});

	it('blocks init / assistant / user / result after status was emitted', () => {
		const { emitter } = makeEmitter();
		emitter.emitStatus(snapshot);

		expect(() => emitter.emitInit({ sessionId: 'abc', cwd: '/tmp' })).toThrow(/init after status/);
		expect(() => emitter.emitAssistantMessage({ role: 'assistant', content: [] })).toThrow(
			/in status mode/
		);
		expect(() => emitter.emitUserMessage({ role: 'user', content: [] })).toThrow(/in status mode/);
		expect(() => emitter.emitResult({ sessionId: 'abc', durationMs: 100, isError: false })).toThrow(
			/in status mode/
		);
	});
});

describe('JsonEmitter — JSONL framing', () => {
	it('produces a stream where every write is exactly one line of valid JSON', () => {
		const { emitter, sink } = makeEmitter();

		emitter.emitInit({ sessionId: 'abc-123', cwd: '/tmp' });
		emitter.emitAssistantMessage({
			role: 'assistant',
			content: [{ type: 'text', text: 'Line one.' }],
		});
		emitter.emitAssistantMessage({
			role: 'assistant',
			content: [{ type: 'text', text: 'Line two.' }],
			stop_reason: 'end_turn',
		});
		emitter.emitResult({ sessionId: 'abc-123', durationMs: 2500, isError: false });

		expect(sink.writes).toHaveLength(4);
		for (const line of sink.writes) {
			expect(line.endsWith('\n')).toBe(true);
			// Exactly one terminator per record; payload itself contains no
			// raw newlines (JSON.stringify escapes them).
			expect(line.split('\n')).toHaveLength(2);
			expect(() => JSON.parse(line.trimEnd())).not.toThrow();
		}
	});

	it('uses process.stdout when no stream is provided to the constructor', () => {
		// Smoke-test the default-binding branch. We don't actually want stdout
		// noise during the test suite, so we route through a spy on the real
		// stdout and assert it was called.
		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			const emitter = new JsonEmitter();
			emitter.emitInit({ sessionId: 'abc', cwd: '/tmp' });
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0].trimEnd())).toMatchObject({
			type: 'system',
			subtype: 'init',
		});
	});
});
