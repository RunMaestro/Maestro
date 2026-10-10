/**
 * Tests for setupExitListener's Cue completion notification routing.
 *
 * Verifies that desktop agent completions resolve their status through the
 * shared turn contract (cueStatusForTurn) when a settlement is present,
 * and fall back to the exit code test only when no settlement is provided.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupExitListener } from '../../../main/process-listeners/exit-listener';
import type { TurnSettlement } from '../../../main/process-manager/types';

interface CueEngineMock {
	hasCompletionSubscribers: ReturnType<typeof vi.fn>;
	notifyAgentCompleted: ReturnType<typeof vi.fn>;
}

function createExitListenerDeps(options: {
	cueEngine?: CueEngineMock | null;
	isCueEnabled?: () => boolean;
}) {
	return {
		safeSend: vi.fn(),
		getProcessManager: () => null,
		getAgentDetector: () => null,
		getWebServer: () => null,
		powerManager: {
			removeBlockReason: vi.fn(),
		},
		outputBuffer: {
			getGroupChatBufferedOutput: vi.fn(),
			clearGroupChatBuffer: vi.fn(),
		},
		outputParser: {
			extractTextFromStreamJson: (s: string) => s,
			parseParticipantSessionId: () => null,
		},
		groupChatEmitters: {},
		groupChatRouter: {
			clearModeratorResponseTimeout: vi.fn(),
			clearActiveParticipantTaskSession: vi.fn(),
		},
		groupChatStorage: {
			loadGroupChat: vi.fn(),
		},
		sessionRecovery: {
			needsSessionRecovery: vi.fn(),
		},
		debugLog: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		patterns: {
			REGEX_MODERATOR_SESSION: /^group-chat-(.+)-moderator-[a-f0-9-]+$/,
		},
		getCueEngine: () => options.cueEngine ?? null,
		isCueEnabled: options.isCueEnabled ?? (() => true),
	} as unknown as Parameters<typeof setupExitListener>[1];
}

describe('setupExitListener - Cue completion notifications', () => {
	let processManager: EventEmitter;
	let cueEngine: CueEngineMock;

	beforeEach(() => {
		processManager = new EventEmitter();
		cueEngine = {
			hasCompletionSubscribers: vi.fn().mockReturnValue(true),
			notifyAgentCompleted: vi.fn(),
		};
	});

	it('notifies completed when settlement outcome is completed-with-warning on exit 1', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		const settlement: TurnSettlement = {
			outcome: 'completed-with-warning',
			answerCaptured: true,
		};

		processManager.emit('exit', 'session-tab-1', 1, undefined, settlement);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			status: 'completed',
			exitCode: 1,
		});
	});

	it('notifies stopped when settlement outcome is interrupted', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		const settlement: TurnSettlement = {
			outcome: 'interrupted',
			answerCaptured: true,
		};

		processManager.emit('exit', 'session-tab-1', 1, undefined, settlement);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			status: 'stopped',
			exitCode: 1,
		});
	});

	it('notifies failed when settlement outcome is crashed', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		const settlement: TurnSettlement = {
			outcome: 'crashed',
			answerCaptured: false,
		};

		processManager.emit('exit', 'session-tab-1', 1, undefined, settlement);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			status: 'failed',
			exitCode: 1,
		});
	});

	it('falls back to exitCode check when settlement is not provided (code 0 -> completed)', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		processManager.emit('exit', 'session-tab-1', 0);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			status: 'completed',
			exitCode: 0,
		});
	});

	it('falls back to exitCode check when settlement is not provided (code 1 -> failed)', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		processManager.emit('exit', 'session-tab-1', 1);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			status: 'failed',
			exitCode: 1,
		});
	});

	it('does not notify Cue when Cue is disabled', () => {
		setupExitListener(
			processManager as never,
			createExitListenerDeps({ cueEngine, isCueEnabled: () => false })
		);

		const settlement: TurnSettlement = {
			outcome: 'completed',
			answerCaptured: true,
		};

		processManager.emit('exit', 'session-tab-1', 0, undefined, settlement);

		expect(cueEngine.hasCompletionSubscribers).not.toHaveBeenCalled();
		expect(cueEngine.notifyAgentCompleted).not.toHaveBeenCalled();
	});

	it('does not notify Cue when session has no completion subscribers', () => {
		cueEngine.hasCompletionSubscribers.mockReturnValue(false);
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		processManager.emit('exit', 'session-tab-1', 0);

		expect(cueEngine.hasCompletionSubscribers).toHaveBeenCalledWith('session-tab-1');
		expect(cueEngine.notifyAgentCompleted).not.toHaveBeenCalled();
	});

	it('does not notify Cue for group chat sessions (domain containment)', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		processManager.emit('exit', 'group-chat-room1-unrecognized', 0);

		expect(cueEngine.notifyAgentCompleted).not.toHaveBeenCalled();
	});
});
