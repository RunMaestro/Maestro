// Source: src/__tests__/main/process-listeners/error-listener.test.ts
// Source: src/__tests__/main/process-listeners/data-listener.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { EventEmitter } from 'events';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { setupErrorListener } from '../../../main/process-listeners/error-listener';
import { captureMessage } from '../../../main/utils/sentry';
import { getEffortRejection } from '../../../shared/effortRejection';
import { resetEffortRejections } from '../../../shared/effortRejection';
import { resolveEffortLevel } from '../../../shared/modelTiers';
import type { AgentError } from '../../../shared/types';
import { setupDataListener } from '../../../main/process-listeners/data-listener';
import type { DataListenerHandle } from '../../../main/process-listeners/data-listener';
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: { markAuthRequired: vi.fn() },
}));
describeSourceSuite('error-listener', () => {
	function refusal(value: string, overrides: Partial<AgentError> = {}): AgentError {
		return {
			type: 'unknown',
			agentId: 'codex',
			recoverable: true,
			timestamp: 0,
			message: `{"type":"error","error":{"message":"Unsupported value: '${value}' is not supported with the 'gpt-6-astra' model. Supported values are: 'medium', 'high'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}`,
			...overrides,
		};
	}

	let processManager: EventEmitter;
	let safeSend: ReturnType<typeof vi.fn>;
	let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		processManager = new EventEmitter();
		safeSend = vi.fn();
		logger = { info: vi.fn(), warn: vi.fn() };
		setupErrorListener(processManager as never, { safeSend, logger } as never, vi.fn());
	});

	afterEach(() => {
		resetEffortRejections();
	});

	describe('setupErrorListener: effort refused by the provider', () => {
		it('still forwards the error to the renderer', () => {
			const error = refusal('low');
			processManager.emit('agent-error', 'tab-naming-1', error);

			expect(safeSend).toHaveBeenCalledWith('agent:error', 'tab-naming-1', error);
		});

		it('takes a refused ladder value out of circulation and reports it', () => {
			expect(resolveEffortLevel('codex', 'low')).toBe('low');

			processManager.emit('agent-error', 'tab-naming-1', refusal('low', { sshRemoteId: 'r1' }));

			expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
			expect(captureMessage).toHaveBeenCalledWith(
				'Provider rejected an effort ladder value',
				'warning',
				{
					agentId: 'codex',
					value: 'low',
					model: 'gpt-6-astra',
					supported: ['medium', 'high'],
					viaSsh: true,
				}
			);
			expect(logger.warn).toHaveBeenCalledTimes(1);
		});

		it('reports each provider and value once, however many turns hit it', () => {
			processManager.emit('agent-error', 'tab-naming-1', refusal('low'));
			processManager.emit('agent-error', 'tab-naming-2', refusal('low'));
			processManager.emit('agent-error', 'groomer-3', refusal('low'));

			expect(captureMessage).toHaveBeenCalledTimes(1);
			expect(logger.warn).toHaveBeenCalledTimes(1);
			// Every one of them is still forwarded.
			expect(safeSend).toHaveBeenCalledTimes(3);
		});

		it('notes a value the user picked but does not report it as ladder drift', () => {
			// `ultra` is offered in the Codex dropdown and never chosen by Maestro.
			// A model refusing it is the user's setting to change, not a stale table.
			processManager.emit('agent-error', 'agent-1-ai-tab-1', refusal('ultra'));

			expect(getEffortRejection('codex', 'ultra')).toBeDefined();
			expect(captureMessage).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledTimes(1);
		});

		it('does nothing extra for an ordinary agent error', () => {
			processManager.emit('agent-error', 'agent-1-ai-tab-1', {
				type: 'rate_limited',
				agentId: 'codex',
				recoverable: true,
				timestamp: 0,
				message: 'Rate limit reached',
			} satisfies AgentError);

			expect(captureMessage).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
			expect(resolveEffortLevel('codex', 'low')).toBe('low');
		});
	});
});
describeSourceSuite('data-listener', () => {
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
});
