import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import {
	useRetryStore,
	noteDispatch,
	scheduleRetryForError,
	cancelContextCompaction,
} from '../../../../../renderer/stores/retryStore';
import { registerContextCompactionSpawner } from '../../../../../renderer/services/contextCompaction';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';
import { DEFAULT_BATCH_STATE } from '../../../../../renderer/hooks/batch/batchReducer';
import type { BatchRunState } from '../../../../../renderer/types';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

let mockIsWebDesktop = false;
let mockIsTabWindow = false;
vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => mockIsWebDesktop,
	isTabWindow: () => mockIsTabWindow,
}));

let handler: ((sessionId: string, code: number) => Promise<void>) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onExit: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
	getActiveProcesses: vi.fn().mockResolvedValue([]),
};

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

function makeDeps() {
	return {
		getBatchStateRef: { current: null },
		processQueuedItemRef: { current: null },
		addHistoryEntryRef: { current: null },
		spawnBackgroundSynopsisRef: { current: null },
		rightPanelRef: { current: null },
		batchedUpdater: {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
			flushNow: vi.fn(),
		},
		activeHiddenToolRef: makeRef(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useSettingsStore.setState(useSettingsStore.getInitialState(), true);
	useNotificationStore.setState(useNotificationStore.getInitialState(), true);
	useNotificationStore.getState().setOsNotifications(false);
	// Completions are asserted in the inbox, which exists only with the Notification Center on.
	useNotificationStore.getState().setHistoryEnabled(true);
	handler = undefined;
	mockIsWebDesktop = false;
	mockIsTabWindow = false;
	useRetryStore.setState({ retries: {}, outages: {} } as any);
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: mockProcess,
		stats: { recordQuery: vi.fn().mockResolvedValue(undefined) },
		logger: { log: vi.fn() },
	};
});

afterEach(async () => {
	// Exit side effects are intentionally deferred; settle them before resetting stores.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

describe('useAgentExitListener', () => {
	it('skips terminal-tab format session ids', async () => {
		renderHook(() => useAgentExitListener(makeDeps()));
		await handler!('sess-1-terminal-tab-1', 0);
		expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
	});

	it('skips batch session ids', async () => {
		renderHook(() => useAgentExitListener(makeDeps()));
		await handler!('sess-1-batch-tab-1', 0);
		expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
	});

	it('transitions an exiting AI tab to idle', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
		});
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].state).toBe('idle');
		expect(updated.state).toBe('idle');
	});

	// 2026-10-12: a `--print` turn emits its whole reply on the final result, an
	// instant before exit, so the reply was still in the batch buffer when the
	// exit reducer appended the next queued message's card. The transcript then
	// read "next question, previous answer" and the running turn looked finished.
	it('lands the finished reply before the next queued message card', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
			logs: [{ id: 'u1', timestamp: 1, source: 'user', text: 'first question' }],
		});
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [
				{ id: 'q-next', timestamp: 2, tabId: 'tab-1', type: 'message', text: 'second question' },
			] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.processQueuedItemRef.current = vi.fn().mockResolvedValue(undefined) as any;
		// The buffered reply only reaches the store when the batch is flushed.
		let buffered = true;
		deps.batchedUpdater.flushNow.mockImplementation(() => {
			if (!buffered) return;
			buffered = false;
			useSessionStore.getState().setSessions((prev) =>
				prev.map((s) => ({
					...s,
					aiTabs: s.aiTabs.map((t) => ({
						...t,
						logs: [
							...t.logs,
							{ id: 'a1', timestamp: 3, source: 'stdout' as const, text: 'first answer' },
						],
					})),
				}))
			);
		});

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		expect(logs.map((l) => l.text)).toEqual(['first question', 'first answer', 'second question']);
		expect(logs[2].queuedItemId).toBe('q-next');
	});

	describe('on a web-desktop client', () => {
		// Every process:* event is fanned out to every connected browser, so a
		// web-desktop client must render the exit (tab idle) but never run the
		// one-shot effects the desktop renderer owns: stats row, queue dequeue,
		// synopsis (and with it the History entry), spoken notification.
		beforeEach(() => {
			mockIsWebDesktop = true;
		});

		it('flips the tab idle but records no stats row', async () => {
			const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 0 });
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 1000,
			});
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentExitListener(makeDeps()));
			await act(async () => {
				await handler!('sess-1-ai-tab-1', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].state).toBe('idle');
			expect(updated.state).toBe('idle');
			expect((window as any).maestro.stats.recordQuery).not.toHaveBeenCalled();
		});

		it('leaves the execution queue intact and dispatches nothing', async () => {
			const tabA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
			const tabB = createMockAITab({ id: 'tab-B', state: 'idle' });
			const itemB = {
				id: 'item-B',
				timestamp: 1,
				tabId: 'tab-B',
				type: 'message' as const,
				text: 'BRAVO',
				readOnlyMode: true,
			};
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-A',
				state: 'busy',
				busySource: 'ai',
				executionQueue: [itemB] as any,
			});
			useSessionStore.setState({ sessions: [session] } as any);

			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = makeDeps();
			deps.processQueuedItemRef.current = processQueuedItem as any;

			renderHook(() => useAgentExitListener(deps));
			await act(async () => {
				await handler!('sess-1-ai-tab-A', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs.find((t) => t.id === 'tab-A')?.state).toBe('idle');
			expect(updated.aiTabs.find((t) => t.id === 'tab-B')?.state).toBe('idle');
			expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-B']);
			expect(updated.state).toBe('idle');
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('never spawns the exit synopsis', async () => {
			const tab = createMockAITab({
				id: 'tab-1',
				state: 'busy',
				thinkingStartTime: 0,
				agentSessionId: 'asid-1',
				logs: [
					{ id: 'l-user', timestamp: 1, source: 'user', text: 'do work' },
					{ id: 'l-tool', timestamp: 2, source: 'tool', text: 'Edit(file.ts)' },
					{ id: 'l-out', timestamp: 3, source: 'stdout', text: 'done' },
				] as any,
			});
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
				busySource: 'ai',
			});
			useSessionStore.setState({ sessions: [session] } as any);

			const spawn = vi.fn();
			const addHistory = vi.fn();
			const deps = makeDeps();
			deps.spawnBackgroundSynopsisRef.current = spawn as any;
			deps.addHistoryEntryRef.current = addHistory as any;

			renderHook(() => useAgentExitListener(deps));
			await act(async () => {
				await handler!('sess-1-ai-tab-1', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			expect(spawn).not.toHaveBeenCalled();
			expect(addHistory).not.toHaveBeenCalled();
		});
	});

	describe('in a tab window', () => {
		// Tab Windows D1 / D2: a tab window is a view of an agent another window
		// owns. It neither renders the exit (the owner's patch does) nor runs a
		// single one-shot effect: no History entry, synopsis, stats row, or queue
		// dequeue.
		beforeEach(() => {
			mockIsTabWindow = true;
		});

		it('ignores the exit entirely: no state change, History, synopsis, stats, or dequeue', async () => {
			const tabA = createMockAITab({
				id: 'tab-A',
				state: 'busy',
				thinkingStartTime: 0,
				agentSessionId: 'asid-1',
				logs: [
					{ id: 'l-user', timestamp: 1, source: 'user', text: 'do work' },
					{ id: 'l-tool', timestamp: 2, source: 'tool', text: 'Edit(file.ts)' },
					{ id: 'l-out', timestamp: 3, source: 'stdout', text: 'done' },
				] as any,
			});
			const tabB = createMockAITab({ id: 'tab-B', state: 'idle' });
			const itemB = {
				id: 'item-B',
				timestamp: 1,
				tabId: 'tab-B',
				type: 'message' as const,
				text: 'BRAVO',
				readOnlyMode: true,
			};
			const session = createMockSession({
				id: 'sess-1',
				aiTabs: [tabA, tabB],
				activeTabId: 'tab-A',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 1000,
				executionQueue: [itemB] as any,
			});
			useSessionStore.setState({ sessions: [session] } as any);

			const spawn = vi.fn();
			const addHistory = vi.fn();
			const processQueuedItem = vi.fn().mockResolvedValue(undefined);
			const deps = makeDeps();
			deps.spawnBackgroundSynopsisRef.current = spawn as any;
			deps.addHistoryEntryRef.current = addHistory as any;
			deps.processQueuedItemRef.current = processQueuedItem as any;

			renderHook(() => useAgentExitListener(deps));
			await act(async () => {
				await handler!('sess-1-ai-tab-A', 0);
				await new Promise((r) => setTimeout(r, 0));
			});

			expect(useSessionStore.getState().sessions[0]).toBe(session);
			expect(spawn).not.toHaveBeenCalled();
			expect(addHistory).not.toHaveBeenCalled();
			expect(processQueuedItem).not.toHaveBeenCalled();
			expect((window as any).maestro.stats.recordQuery).not.toHaveBeenCalled();
			expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
		});
	});

	it('appends a system log on terminal exit', async () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-terminal', 1);
		});

		const updated = useSessionStore.getState().sessions[0];
		const log = updated.shellLogs[updated.shellLogs.length - 1];
		expect(log?.text).toContain('exited with code 1');
	});

	it('retires a finished orphan and dispatches the next queued item for ANOTHER tab exactly once', async () => {
		// Regression: A is a closed/orphaned tab whose turn just finished. B is a
		// second closed/orphaned tab with a queued read-only message; C is an open
		// tab with a queued read-only message. When A exits, the retire branch must
		// dequeue B's item (in lockstep with the post-reducer spawn) and mark B busy
		// - NOT leave it in the queue. Leaving it queued caused B to run twice (once
		// from queuedItemToProcess at A's exit, again when that run exited) and never
		// surface as busy in the UI.
		const orphanA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
		const orphanB = createMockAITab({ id: 'tab-B', state: 'idle', agentSessionId: 'asid-B' });
		const tabC = createMockAITab({ id: 'tab-C', state: 'idle' });
		const itemB = {
			id: 'item-B',
			timestamp: 1,
			tabId: 'tab-B',
			type: 'message' as const,
			text: 'BRAVO',
			readOnlyMode: true,
		};
		const itemC = {
			id: 'item-C',
			timestamp: 2,
			tabId: 'tab-C',
			type: 'message' as const,
			text: 'CHARLIE',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tabC],
			orphanedThinkingTabs: [orphanA, orphanB],
			activeTabId: 'tab-C',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [itemB, itemC] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-A', 0);
			// queued-item dispatch is fired on a setTimeout(0) after the reducer
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		// A retired; B promoted to busy and dequeued; C still queued.
		expect(updated.orphanedThinkingTabs?.map((t) => t.id)).toEqual(['tab-B']);
		expect(updated.orphanedThinkingTabs?.[0].state).toBe('busy');
		expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-C']);
		expect(updated.state).toBe('busy');
		// Spawned exactly once, with B's item.
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem.mock.calls[0][1].id).toBe('item-B');
	});

	it('retires a finished orphan with no queued work and goes idle', async () => {
		const orphanA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [createMockAITab({ id: 'tab-C', state: 'idle' })],
			orphanedThinkingTabs: [orphanA],
			activeTabId: 'tab-C',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-A', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.orphanedThinkingTabs).toBeUndefined();
		expect(updated.state).toBe('idle');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	// Desktop document/spec-mode Auto Run synopsizes each task from this exit path,
	// which sets up the synopsis and dispatches it via runExitSynopsis (reaching
	// spawnBackgroundSynopsisRef), so the run-scoped model override must reach the
	// synopsis spawn config here for parity with the CLI batch processor.
	function setupSynopsisRun(opts: { sessionCustomModel?: string; runModelOverride?: string }) {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
			agentSessionId: 'asid-1',
			// Auto Run tabs opt into the exit-path synopsis via saveToHistory.
			saveToHistory: true,
			// Thinking on -> tool logs are recorded, so the activity gate trusts the
			// tool log below as evidence of meaningful work.
			showThinking: 'on',
			logs: [
				{ id: 'l-user', timestamp: 1, source: 'user', text: 'do the task' },
				{ id: 'l-tool', timestamp: 2, source: 'tool', text: 'Edit(file.ts)' },
			],
		} as any);
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			customModel: opts.sessionCustomModel,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const spawn = vi.fn().mockResolvedValue({ success: false });
		const deps = makeDeps();
		deps.spawnBackgroundSynopsisRef.current = spawn as any;
		// runExitSynopsis bails before spawning unless a history-entry sink exists.
		deps.addHistoryEntryRef.current = vi.fn() as any;
		// The active run exposes its per-run model override via getBatchStateRef.
		const batchState: BatchRunState = {
			...DEFAULT_BATCH_STATE,
			isRunning: true,
			runModelOverride: opts.runModelOverride,
		};
		deps.getBatchStateRef.current = (() => batchState) as any;
		return { deps, spawn };
	}

	it('spawns the exit-path synopsis under the run model override, not the session model', async () => {
		const { deps, spawn } = setupSynopsisRun({
			sessionCustomModel: 'session-sonnet',
			runModelOverride: 'run-opus',
		});

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		// 6th arg is the synopsis sessionConfig.
		const sessionConfig = spawn.mock.calls[0][5];
		expect(sessionConfig.customModel).toBe('run-opus');
	});

	it('falls back to the session model when the run has no model override', async () => {
		const { deps, spawn } = setupSynopsisRun({
			sessionCustomModel: 'session-sonnet',
			runModelOverride: undefined,
		});

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		const sessionConfig = spawn.mock.calls[0][5];
		expect(sessionConfig.customModel).toBe('session-sonnet');
	});

	// Agent Resilience: the exiting turn failed and a resend is counting down.
	// The reducer must leave the queue alone. Draining it would fail every item
	// against the same provider, and the dispatch would supersede the pending
	// retry (noteDispatch), silently discarding the prompt that is waiting.
	it('holds the execution queue while a retry is counting down', async () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 0 });
		const queued = {
			id: 'item-1',
			timestamp: 1,
			tabId: 'tab-1',
			type: 'message' as const,
			text: 'QUEUED',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [queued] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);
		useRetryStore.setState({
			retries: {
				'sess-1:tab-1': {
					sessionId: 'sess-1',
					tabId: 'tab-1',
					key: 'sess-1:tab-1',
					outageId: 'outage-1',
					strategy: { kind: 'fixed', delayMs: 60_000, maxAttempts: 5 },
					mode: 'auto',
					status: 'scheduled',
					attempt: 0,
					startedAt: 0,
					nextRetryAt: 60_000,
					lastMessage: 'overloaded',
				},
			},
		} as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 1);
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-1']);
		expect(updated.aiTabs[0].state).toBe('idle');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	// A failed attempt is not a completed turn. Each attempt of an outage used to
	// raise a green "success" toast quoting whatever the dying turn printed last,
	// so the user was told the work was done three times while it had not run.
	it.each([
		['raises no completion toast while a retry is counting down', true, 0],
		['raises the completion toast once no retry is pending', false, 1],
	])('%s', async (_name, retryPending, expectedToasts) => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
			logs: [
				{ id: 'u', timestamp: 1, source: 'user', text: 'do the thing' },
				{ id: 'a', timestamp: 2, source: 'stdout', text: 'Halfway there before it died.' },
			],
		});
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
		});
		useSessionStore.setState({ sessions: [session] } as any);
		useNotificationStore.setState({ toasts: [] } as any);
		if (retryPending) {
			useRetryStore.setState({
				retries: {
					'sess-1:tab-1': {
						sessionId: 'sess-1',
						tabId: 'tab-1',
						key: 'sess-1:tab-1',
						outageId: 'outage-1',
						mode: 'resend',
						status: 'scheduled',
						attempt: 0,
						startedAt: 0,
						nextRetryAt: 60_000,
						lastMessage: 'Your workspace is out of credits.',
					},
				},
			} as any);
		}

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 1);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(useNotificationStore.getState().toasts).toHaveLength(expectedToasts);
		expect(useNotificationStore.getState().history).toHaveLength(expectedToasts);
	});

	it('drains the queue normally once the retry has settled', async () => {
		// Same shape as above with no retry entry: proves the hold is the retry's
		// doing, not the exit code or the read-only flag.
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 0 });
		const queued = {
			id: 'item-1',
			timestamp: 1,
			tabId: 'tab-1',
			type: 'message' as const,
			text: 'QUEUED',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [queued] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 1);
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(useSessionStore.getState().sessions[0].executionQueue).toEqual([]);
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	// The whole point of tying the compaction to this exit: the failed turn's
	// process is gone (no second writer on the provider session), the tab has
	// been settled, and no synopsis or completion runs for a turn that is about
	// to be re-run.
	it('starts a waiting context compaction once the failed turn has exited', async () => {
		const compact = vi.fn(() => new Promise<{ success: boolean }>(() => {}));
		registerContextCompactionSpawner(compact);
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
			agentSessionId: 'claude-abc',
			saveToHistory: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);
		noteDispatch(
			'sess-1',
			{ id: 'turn-1', timestamp: 1, tabId: 'tab-1', type: 'message', text: 'hi' },
			{} as any
		);
		scheduleRetryForError('sess-1', 'tab-1', {
			type: 'token_exhaustion',
			message: 'Prompt is too long',
			recoverable: true,
			timestamp: 1,
			agentId: 'claude-code',
		} as any);
		expect(compact).not.toHaveBeenCalled();

		const deps = makeDeps();
		const spawnSynopsis = vi.fn();
		deps.spawnBackgroundSynopsisRef = { current: spawnSynopsis } as any;
		const processQueuedItem = vi.fn().mockResolvedValue(true);
		deps.processQueuedItemRef = { current: processQueuedItem } as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 1);
		});

		expect(compact).toHaveBeenCalledTimes(1);
		// The turn still reads as running, the parked prompt was not drained, and
		// the turn that died got no synopsis.
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].state).toBe('busy');
		expect(updated.state).toBe('busy');
		expect(updated.executionQueue.map((i) => i.id)).toEqual(['turn-1']);
		expect(processQueuedItem).not.toHaveBeenCalled();
		expect(spawnSynopsis).not.toHaveBeenCalled();
		expect(useRetryStore.getState().retries['sess-1:tab-1']?.status).toBe('in-flight');

		cancelContextCompaction('sess-1');
		registerContextCompactionSpawner(null);
	});

	it('deletes activeHiddenToolRef entry on AI exit', async () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		expect(deps.activeHiddenToolRef.current.has('sess-1:tab-1')).toBe(false);
	});
	it.each([true, false])(
		'records a final completion with viewing=%s while retaining popup/audio defaults',
		async (viewing) => {
			const tab = createMockAITab({
				id: 'tab-1',
				state: 'busy',
				thinkingStartTime: Date.now() - 100,
				logs: [],
			});
			useSessionStore.setState({
				sessions: [
					createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1', state: 'busy' }),
				],
				activeSessionId: viewing ? 'sess-1' : '',
			});
			const speak = vi.fn().mockResolvedValue(undefined);
			window.maestro.notification.speak = speak;
			useNotificationStore.getState().setAudioFeedback(true, 'say');
			renderHook(() => useAgentExitListener(makeDeps()));
			await act(async () => {
				await handler!('sess-1-ai-tab-1', 0);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(useNotificationStore.getState().history).toHaveLength(1);
			expect(useNotificationStore.getState().toasts).toHaveLength(viewing ? 0 : 1);
			expect(speak).toHaveBeenCalledTimes(1);
		}
	);

	it.each([false, true])(
		'records intermediate queued replies only when opted in (%s)',
		async (enabled) => {
			useSettingsStore.setState({ notificationHistoryQueuedReplies: enabled });
			const tab = createMockAITab({
				id: 'tab-1',
				state: 'busy',
				thinkingStartTime: Date.now() - 100,
				logs: [],
			});
			const queued = {
				id: 'next',
				timestamp: 1,
				tabId: 'tab-1',
				type: 'message' as const,
				text: 'Next',
				readOnlyMode: true,
			};
			useSessionStore.setState({
				sessions: [
					createMockSession({
						id: 'sess-1',
						aiTabs: [tab],
						activeTabId: 'tab-1',
						state: 'busy',
						executionQueue: [queued],
					}),
				],
			});
			const dispatch = vi.fn().mockResolvedValue(undefined);
			const deps = makeDeps();
			deps.processQueuedItemRef.current = dispatch as never;
			renderHook(() => useAgentExitListener(deps));
			await act(async () => {
				await handler!('sess-1-ai-tab-1', 0);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(useNotificationStore.getState().history).toHaveLength(enabled ? 1 : 0);
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		}
	);
});
