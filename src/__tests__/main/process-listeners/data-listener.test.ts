/**
 * Tests for setupDataListener's output coalescing, focused on the ordering
 * guarantee that one-off commands depend on.
 *
 * process:data is coalesced into ~16ms windows for IPC volume. A fast command
 * (`ls`) emits all of its output and exits well inside that window, so unless
 * the buffer is flushed when the command exits, the renderer is told the command
 * finished while its output is still buffered. Consumers tear down their output
 * listeners on exit, so that output is dropped and the command appears to have
 * printed nothing.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDataListener } from '../../../main/process-listeners/data-listener';

const SESSION_ID = 'session-1-shell-run1';

function createDeps(safeSend: ReturnType<typeof vi.fn>) {
	return {
		safeSend,
		getWebServer: () => null,
		outputBuffer: {
			appendToGroupChatBuffer: vi.fn().mockReturnValue(0),
			getGroupChatBufferedOutput: vi.fn(),
			clearGroupChatBuffer: vi.fn(),
		},
		outputParser: {
			extractTextFromStreamJson: (s: string) => s,
			parseParticipantSessionId: () => null,
		},
		debugLog: vi.fn(),
		patterns: {
			REGEX_MODERATOR_SESSION: /^group-chat-(.+)-moderator-\d+$/,
			REGEX_MODERATOR_SESSION_TIMESTAMP: /^group-chat-(.+)-moderator-(\d+)$/,
			REGEX_AI_SUFFIX: /-ai$/,
			REGEX_AI_TAB_ID: /^(.+)-ai-(.+)$/,
			REGEX_BATCH_SESSION: /^(.+)-batch-\d+$/,
			REGEX_SYNOPSIS_SESSION: /^(.+)-synopsis-\d+$/,
		},
	} as unknown as Parameters<typeof setupDataListener>[1];
}

/** Channels sent to the renderer, in order. */
function channels(safeSend: ReturnType<typeof vi.fn>): string[] {
	return safeSend.mock.calls.map((c) => c[0] as string);
}

let processManager: EventEmitter;
let safeSend: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.useFakeTimers();
	processManager = new EventEmitter();
	safeSend = vi.fn();
	setupDataListener(processManager as never, createDeps(safeSend));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('setupDataListener - one-off command output', () => {
	it('flushes buffered output BEFORE forwarding command-exit', () => {
		// Exactly the `ls` case: output and exit inside one coalescing window.
		processManager.emit('data', SESSION_ID, 'file-a\nfile-b\n');
		processManager.emit('command-exit', SESSION_ID, 0);

		// Both must have been sent, and data must come first - a consumer that
		// unsubscribes on exit only sees output that arrived before it.
		expect(channels(safeSend)).toEqual(['process:data', 'process:command-exit']);
		expect(safeSend.mock.calls[0][2]).toBe('file-a\nfile-b\n');
		expect(safeSend.mock.calls[1][2]).toBe(0);
	});

	it('does not lose output when the command exits immediately', () => {
		processManager.emit('data', SESSION_ID, 'only line\n');
		processManager.emit('command-exit', SESSION_ID, 0);

		// Any later timer firing must not re-send: the flush already consumed it.
		vi.advanceTimersByTime(100);

		const dataSends = safeSend.mock.calls.filter((c) => c[0] === 'process:data');
		expect(dataSends).toHaveLength(1);
		expect(dataSends[0][2]).toBe('only line\n');
	});

	it('concatenates multiple chunks into the pre-exit flush', () => {
		processManager.emit('data', SESSION_ID, 'a');
		processManager.emit('data', SESSION_ID, 'b');
		processManager.emit('data', SESSION_ID, 'c');
		processManager.emit('command-exit', SESSION_ID, 0);

		const dataSends = safeSend.mock.calls.filter((c) => c[0] === 'process:data');
		expect(dataSends).toHaveLength(1);
		expect(dataSends[0][2]).toBe('abc');
	});

	it('still forwards the exit code when the command printed nothing', () => {
		processManager.emit('command-exit', SESSION_ID, 127);

		expect(channels(safeSend)).toEqual(['process:command-exit']);
		expect(safeSend.mock.calls[0][2]).toBe(127);
	});

	it('only flushes the exiting session, leaving other sessions buffered', () => {
		processManager.emit('data', 'other-session', 'not mine\n');
		processManager.emit('data', SESSION_ID, 'mine\n');
		processManager.emit('command-exit', SESSION_ID, 0);

		const dataSends = safeSend.mock.calls.filter((c) => c[0] === 'process:data');
		expect(dataSends).toHaveLength(1);
		expect(dataSends[0][1]).toBe(SESSION_ID);
		expect(dataSends[0][2]).toBe('mine\n');
	});

	it('still coalesces on the timer when no exit arrives', () => {
		processManager.emit('data', SESSION_ID, 'x');
		expect(channels(safeSend)).toEqual([]);

		vi.advanceTimersByTime(20);
		expect(channels(safeSend)).toEqual(['process:data']);
	});
});
