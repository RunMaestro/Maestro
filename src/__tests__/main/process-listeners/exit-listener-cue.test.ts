/**
 * Tests for setupExitListener's Cue completion notification routing.
 *
 * Verifies that desktop agent completions resolve their status through the
 * shared turn contract (cueStatusForTurn) when a settlement is present,
 * and fall back to the exit code test only when no settlement is provided.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupExitListener } from '../../../main/process-listeners/exit-listener';
import type { TurnSettlement } from '../../../main/process-manager/types';
import { createCueCompletionService } from '../../../main/cue/cue-completion-service';
import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import type { CueCompletionService } from '../../../main/cue/cue-completion-service';
import type { CueSubscription } from '../../../main/cue/cue-types';
import { createMockConfig, createMockSession } from '../cue/cue-test-helpers';

interface CueEngineMock {
	hasCompletionSubscribers: ReturnType<typeof vi.fn>;
	notifyAgentCompleted: ReturnType<typeof vi.fn>;
}

function createExitListenerDeps(options: {
	cueEngine?: CueCompletionService | null;
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
		groupChatEngine: {
			turnEnded: vi.fn().mockResolvedValue(undefined),
		},
		groupChatLauncherFor: vi.fn(),
		groupChatStorage: {
			loadGroupChat: vi.fn(),
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
			sourceProcessId: 'session-tab-1',
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
			sourceProcessId: 'session-tab-1',
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
			sourceProcessId: 'session-tab-1',
			status: 'failed',
			exitCode: 1,
		});
	});

	it('falls back to exitCode check when settlement is not provided (code 0 -> completed)', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		processManager.emit('exit', 'session-tab-1', 0);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			sourceProcessId: 'session-tab-1',
			status: 'completed',
			exitCode: 0,
		});
	});

	it('falls back to exitCode check when settlement is not provided (code 1 -> failed)', () => {
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine }));

		processManager.emit('exit', 'session-tab-1', 1);

		expect(cueEngine.notifyAgentCompleted).toHaveBeenCalledWith('session-tab-1', {
			sourceProcessId: 'session-tab-1',
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

describe('desktop exit to Cue completion adapter', () => {
	const worker = createMockSession({ id: 'worker-ai-primary', name: 'Worker' });
	const otherWorker = createMockSession({ id: 'other-worker', name: 'Other worker' });
	let processManager: EventEmitter;
	let onDispatch: ReturnType<typeof vi.fn>;
	let service: CueCompletionService;
	let fanInTracker: ReturnType<typeof createCueFanInTracker>;

	beforeEach(() => {
		vi.clearAllMocks();
		processManager = new EventEmitter();
		onDispatch = vi.fn();
	});

	afterEach(() => fanInTracker?.reset());

	function connect(
		subscriptions: Array<Pick<CueSubscription, 'name' | 'event'> & Partial<CueSubscription>>
	) {
		const sessions = [worker, otherWorker];
		fanInTracker = createCueFanInTracker({
			getSessions: () => sessions,
			onLog: vi.fn(),
			dispatchSubscription: onDispatch,
		});
		service = createCueCompletionService({
			enabled: () => true,
			getSessions: () => sessions,
			getSessionConfigs: () =>
				new Map([
					[
						'manager',
						{
							config: createMockConfig({
								subscriptions: subscriptions.map((sub) => ({
									enabled: true,
									prompt: 'Inspect the worker result',
									...sub,
								})),
							}),
						},
					],
				]),
			fanInTracker,
			onDispatch,
			onLog: vi.fn(),
			maxChainDepth: 10,
		});
		setupExitListener(processManager as never, createExitListenerDeps({ cueEngine: service }));
	}

	it.each([worker.id, worker.name])(
		'routes an immediate Dispatch-tab exit to source %s without waiting for a transcript',
		(source) => {
			connect([{ name: 'worker-return', event: 'agent.completed', source_session: source }]);
			const processId = `${worker.id}-ai-task-tab`;

			processManager.emit('exit', processId, 0, undefined, {
				outcome: 'completed',
				answerCaptured: true,
			});

			expect(onDispatch).toHaveBeenCalledOnce();
			expect(onDispatch.mock.calls[0][2].payload).toMatchObject({
				sourceSession: worker.name,
				sourceSessionId: worker.id,
				sourceProcessId: processId,
				sourceTabId: 'task-tab',
				status: 'completed',
				sourceOutput: '',
			});
			expect(onDispatch.mock.calls[0][2].payload.triggeredBy).toBeUndefined();
			expect(onDispatch.mock.calls[0][5]).toBeUndefined();
			expect(onDispatch.mock.calls[0][6]).toBeUndefined();
		}
	);

	it.each([
		['crashed', 0, 'failed'],
		['interrupted', 0, 'stopped'],
		['completed-with-warning', 1, 'completed'],
	] as const)('preserves structured %s outcome from a Dispatch worker', (outcome, code, status) => {
		connect([{ name: 'worker-return', event: 'agent.completed', source_session: worker.id }]);

		processManager.emit('exit', `${worker.id}-ai-task-tab`, code, undefined, {
			outcome,
			answerCaptured: outcome === 'completed-with-warning',
		});

		expect(onDispatch).toHaveBeenCalledOnce();
		expect(onDispatch.mock.calls[0][2].payload).toMatchObject({ status, exitCode: code });
	});

	it('keeps independent tab identity available to the subscription filter', () => {
		connect([
			{
				name: 'expected-tab-only',
				event: 'agent.completed',
				source_session: worker.id,
				filter: { sourceTabId: 'expected-tab' },
			},
		]);

		processManager.emit('exit', `${worker.id}-ai-unrelated-tab`, 0);
		expect(onDispatch).not.toHaveBeenCalled();
		processManager.emit('exit', `${worker.id}-ai-expected-tab`, 1, undefined, {
			outcome: 'interrupted',
			answerCaptured: false,
		});
		expect(onDispatch).toHaveBeenCalledOnce();
		expect(onDispatch.mock.calls[0][2].payload.status).toBe('stopped');
	});

	it('does not invent Cue subscription provenance for external Dispatch runs', () => {
		connect([
			{
				name: 'cue-upstream-only',
				event: 'agent.completed',
				source_session: worker.id,
				source_sub: 'actual-cue-sub',
			},
		]);

		processManager.emit('exit', `${worker.id}-ai-task-tab`, 0);
		expect(onDispatch).not.toHaveBeenCalled();

		service.notifyAgentCompleted(worker.id, {
			triggeredBy: 'actual-cue-sub',
			parentRunId: 'cue-run',
			chainRootId: 'cue-root',
			stdout: 'acceptance output',
		});
		expect(onDispatch).toHaveBeenCalledOnce();
		expect(onDispatch.mock.calls[0][2].payload).toMatchObject({
			triggeredBy: 'actual-cue-sub',
			sourceOutput: 'acceptance output',
		});
		expect(onDispatch.mock.calls[0][5]).toBe('cue-root');
		expect(onDispatch.mock.calls[0][6]).toBe('cue-run');
	});

	it('correlates fan-in by agent and does not count two tabs as two workers', () => {
		connect([
			{
				name: 'both-workers',
				event: 'agent.completed',
				source_session: [worker.id, otherWorker.name],
			},
		]);

		processManager.emit('exit', `${worker.id}-ai-tab-one`, 0);
		processManager.emit('exit', `${worker.id}-ai-tab-two`, 0);
		expect(onDispatch).not.toHaveBeenCalled();
		processManager.emit('exit', `${otherWorker.id}-ai-tab-three`, 0);
		expect(onDispatch).toHaveBeenCalledOnce();
		expect(fanInTracker.getActiveTrackerKeys()).toEqual([]);
	});

	it('does not route terminal, group-chat or Cue-owned process IDs as a worker completion', () => {
		connect([{ name: 'worker-return', event: 'agent.completed', source_session: worker.id }]);

		for (const processId of [
			`${worker.id}-terminal-shell`,
			`group-chat-${worker.id}-unrecognized`,
			`cue-${worker.id}`,
		]) {
			processManager.emit('exit', processId, 0);
		}
		expect(onDispatch).not.toHaveBeenCalled();
	});
});
