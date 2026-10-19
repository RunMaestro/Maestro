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
 *
 * The same window sits in front of `agent:error`, which is sent at once. The
 * renderer reads output that lands AFTER an error as the agent having recovered
 * and erases the error, so a turn's last output has to be released first.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: { markAuthRequired: vi.fn() },
}));

import {
	setupDataListener,
	type DataListenerHandle,
} from '../../../main/process-listeners/data-listener';
import { setupErrorListener } from '../../../main/process-listeners/error-listener';
import { terminalHandoff } from '../../../main/terminal-handoff';
import type { AgentError } from '../../../shared/types';

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
let dataListener: DataListenerHandle;

beforeEach(() => {
	vi.useFakeTimers();
	processManager = new EventEmitter();
	safeSend = vi.fn();
	dataListener = setupDataListener(processManager as never, createDeps(safeSend));
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

describe('setupDataListener - output ahead of an agent error', () => {
	const AI_SESSION_ID = 'session-1-ai-tab-1';
	// Captured from `claude -p` with an expired OAuth login: the failure text is
	// the turn's result, and the classified error follows it within the same tick.
	const AUTH_FAILURE_TEXT =
		'Failed to authenticate: OAuth session expired and could not be refreshed';
	const authError: AgentError = {
		type: 'auth_expired',
		agentId: 'claude-code',
		message: 'Authentication failed. Sign in again to continue.',
		recoverable: true,
		timestamp: 0,
	};

	beforeEach(() => {
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		setupErrorListener(
			processManager as never,
			{ safeSend, logger } as never,
			dataListener.flushPendingData
		);
	});

	it('sends the output a failed turn produced BEFORE its error', () => {
		processManager.emit('data', AI_SESSION_ID, AUTH_FAILURE_TEXT);
		processManager.emit('agent-error', AI_SESSION_ID, authError);

		expect(channels(safeSend)).toEqual(['process:data', 'agent:error']);
		expect(safeSend.mock.calls[0][2]).toBe(AUTH_FAILURE_TEXT);
	});

	it('sends nothing after the error once the coalescing window elapses', () => {
		processManager.emit('data', AI_SESSION_ID, AUTH_FAILURE_TEXT);
		processManager.emit('agent-error', AI_SESSION_ID, authError);
		processManager.emit('exit', AI_SESSION_ID, 1);
		vi.advanceTimersByTime(100);

		// A late `process:data` is what un-blocks the agent and lets the queue
		// drain into the failure, so the error must be the last word.
		expect(channels(safeSend)).toEqual(['process:data', 'agent:error']);
	});

	it('leaves another session buffered when one session errors', () => {
		processManager.emit('data', 'session-2-ai-tab-9', 'still streaming');
		processManager.emit('data', AI_SESSION_ID, AUTH_FAILURE_TEXT);
		processManager.emit('agent-error', AI_SESSION_ID, authError);

		const dataSends = safeSend.mock.calls.filter((c) => c[0] === 'process:data');
		expect(dataSends).toHaveLength(1);
		expect(dataSends[0][1]).toBe(AI_SESSION_ID);
	});

	it('forwards an error that had no output in front of it', () => {
		processManager.emit('agent-error', AI_SESSION_ID, authError);

		expect(channels(safeSend)).toEqual(['agent:error']);
	});
});

describe('setupDataListener - Tab Windows terminal handoff (D5)', () => {
	// A terminal tab whose view is moving between windows has its output held in
	// main, at the moment it is sent, so the next view's replay is exact.
	const PTY = 'agent-1-terminal-term-1';

	afterEach(() => {
		terminalHandoff.clear();
	});

	it('holds the output it sends while a release is open', () => {
		terminalHandoff.begin(PTY);
		processManager.emit('data', PTY, 'a');
		processManager.emit('data', PTY, 'b');
		vi.advanceTimersByTime(16);
		terminalHandoff.commit(PTY, 'scrollback ');

		const reply = vi.fn();
		terminalHandoff.claim(PTY, reply);

		expect(safeSend).toHaveBeenCalledWith('process:data', PTY, 'ab');
		expect(reply).toHaveBeenCalledWith('scrollback ab');
	});

	it('holds nothing for a PTY with no handoff', () => {
		processManager.emit('data', PTY, 'a');
		vi.advanceTimersByTime(16);

		expect(terminalHandoff.has(PTY)).toBe(false);
	});
});
