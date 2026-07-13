import { describe, expect, it, vi } from 'vitest';
import {
	MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES,
	MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES,
} from '../../../shared/plugins/interactive-runtime';
import { ManagedRuntimeProcess } from '../../../main/plugins/managed-runtime-process';

function canonicalJsonLineWithFrameBytes(byteLength: number): string {
	const overhead = Buffer.byteLength('{"data":""}');
	return `${JSON.stringify({ data: 'x'.repeat(byteLength - overhead) })}\n`;
}

function createRuntime() {
	let stdoutListener: ((data: Uint8Array | string) => void) | undefined;
	const writes: string[] = [];
	const child = {
		stdin: {
			writableLength: 0,
			write(data: string) {
				writes.push(data);
				return true;
			},
			on: vi.fn(),
		},
		stdout: {
			on(event: 'data', listener: (data: Uint8Array | string) => void) {
				if (event === 'data') stdoutListener = listener;
			},
		},
		stderr: { on: vi.fn() },
		exitCode: null,
		on: vi.fn(),
		kill: vi.fn(() => true),
	};
	const runtime = new ManagedRuntimeProcess({ child, killTree: async () => undefined });
	return {
		runtime,
		writes,
		emitStdout(data: string) {
			if (!stdoutListener) throw new Error('stdout listener was not installed');
			stdoutListener(data);
		},
	};
}

describe('ManagedRuntimeProcess frame budgets', () => {
	it('accepts just-under and exact 3 MiB child input frames, rejects one byte over before write, and stays writable', async () => {
		const { runtime, writes } = createRuntime();
		const inputSizes = [
			MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES - 1,
			MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES,
		];

		for (const size of inputSizes) {
			await runtime.writeCanonicalJson({
				data: 'x'.repeat(size - Buffer.byteLength('{"data":""}\n')),
			});
		}
		await expect(
			runtime.writeCanonicalJson({
				data: 'x'.repeat(
					MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES + 1 - Buffer.byteLength('{"data":""}\n')
				),
			})
		).rejects.toThrow('runtime input frame exceeds the maximum size');

		expect(writes).toHaveLength(2);
		await expect(runtime.writeCanonicalJson({ type: 'after-rejection' })).resolves.toBeUndefined();
		expect(writes).toHaveLength(3);
	});

	it('keeps the runtime stdout frame limit at 256 KiB', () => {
		const accepted = createRuntime();
		const acceptedMessages: unknown[] = [];
		accepted.runtime.onMessage((message) => acceptedMessages.push(message));
		accepted.emitStdout(
			canonicalJsonLineWithFrameBytes(MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES - 1)
		);
		accepted.emitStdout(
			canonicalJsonLineWithFrameBytes(MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES)
		);
		expect(acceptedMessages).toHaveLength(2);

		const rejected = createRuntime();
		const events: unknown[] = [];
		rejected.runtime.onEvent((event) => events.push(event));
		rejected.emitStdout(
			canonicalJsonLineWithFrameBytes(MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES + 1)
		);
		expect(events).toContainEqual(
			expect.objectContaining({ kind: 'safe_error', class: 'invalid_request' })
		);
	});
});
