/**
 * @file stdin.test.ts
 * @description Standard input for CLI verbs. A verb that reads it only when
 * nothing else names its input must not wait on a pipe nobody writes to: an
 * agent's harness often leaves one open, and a blocking read of it never ends.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';

import { isStdinTerminal, readStdinIfReady } from '../../../cli/services/stdin';

const original = Object.getOwnPropertyDescriptor(process, 'stdin');

type FakeStdin = PassThrough & { isTTY?: boolean; unref: () => void };

/** Put a stream in the place of standard input. */
function useStdin(isTTY: boolean): FakeStdin {
	const stream = Object.assign(new PassThrough(), { isTTY, unref: vi.fn() }) as FakeStdin;
	Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
	return stream;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	if (original) Object.defineProperty(process, 'stdin', original);
});

describe('readStdinIfReady', () => {
	it('answers null for a terminal, and attaches no listener to it', async () => {
		const stream = useStdin(true);
		expect(isStdinTerminal()).toBe(true);
		expect(await readStdinIfReady()).toBeNull();
		expect(stream.listenerCount('data')).toBe(0);
	});

	it('reads what was piped, to the end', async () => {
		const stream = useStdin(false);
		expect(isStdinTerminal()).toBe(false);
		const read = readStdinIfReady(1_000);
		stream.write('The first half, ');
		stream.end('and the second.');
		expect(await read).toBe('The first half, and the second.');
	});

	it('gives up on a pipe nobody writes to, and lets go of it', async () => {
		const stream = useStdin(false);
		const read = readStdinIfReady(1_000);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(await read).toBeNull();
		expect(stream.listenerCount('data')).toBe(0);
		expect(stream.listenerCount('end')).toBe(0);
		expect(stream.isPaused()).toBe(true);
		expect(stream.unref).toHaveBeenCalled();
	});

	it('does not cut short a writer that has started, however slow it is', async () => {
		const stream = useStdin(false);
		const read = readStdinIfReady(1_000);
		stream.write('slow ');
		await vi.advanceTimersByTimeAsync(5_000);
		stream.end('writer');
		expect(await read).toBe('slow writer');
	});

	it('answers an empty string for a pipe that closes with nothing in it', async () => {
		const stream = useStdin(false);
		const read = readStdinIfReady(1_000);
		stream.end();
		expect(await read).toBe('');
	});
});
