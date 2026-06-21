import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchRunState, QueuedItem, Session } from '../../renderer/types';

const processor = vi.hoisted(() => ({
	options: undefined as any,
	activeBatchSessionIds: [] as string[],
	getBatchState: vi.fn(),
	startBatchRun: vi.fn().mockResolvedValue(undefined),
	stopBatchRun: vi.fn(),
	killBatchRun: vi.fn().mockResolvedValue(undefined),
	pauseBatchOnError: vi.fn(),
	skipCurrentDocument: vi.fn(),
	resumeAfterError: vi.fn(),
	abortBatchOnError: vi.fn(),
}));

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

vi.mock('../../renderer/hooks/batch/useBatchProcessor', () => ({
	useBatchProcessor: vi.fn((options) => {
		processor.options = options;
		return {
			batchRunStates: {},
			getBatchState: processor.getBatchState,
			activeBatchSessionIds: processor.activeBatchSessionIds,
			startBatchRun: processor.startBatchRun,
			stopBatchRun: processor.stopBatchRun,
			killBatchRun: processor.killBatchRun,
			pauseBatchOnError: processor.pauseBatchOnError,
			skipCurrentDocument: processor['skipCurrentDocument'],
			resumeAfterError: processor.resumeAfterError,
			abortBatchOnError: processor.abortBatchOnError,
		};
	}),
}));

vi.mock('@sentry/electron/renderer', () => ({
	captureException: sentry.captureException,
}));

import { useBatchHandlers } from '../../renderer/hooks/batch/useBatchHandlers';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { registerGroupChatAutoRun } from '../../renderer/utils/groupChatAutoRunRegistry';

const autoRunStats = {
	cumulativeTimeMs: 0,
	longestRunMs: 0,
	longestRunTimestamp: 0,
	totalRuns: 0,
	currentBadgeLevel: 0,
	lastBadgeUnlockLevel: 0,
	lastAcknowledgedBadgeLevel: 0,
	badgeHistory: [],
};

function batchState(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return {
		isRunning: false,
		isStopping: false,
		documents: [],
		lockedDocuments: [],
		currentDocumentIndex: 0,
		currentDocTasksTotal: 0,
		currentDocTasksCompleted: 0,
		totalTasksAcrossAllDocs: 0,
		completedTasksAcrossAllDocs: 0,
		loopEnabled: false,
		loopIteration: 0,
		folderPath: '',
		worktreeActive: false,
		totalTasks: 0,
		completedTasks: 0,
		currentTaskIndex: 0,
		originalContent: '',
		sessionIds: [],
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent One',
		state: 'idle',
		toolType: 'claude-code',
		cwd: '/repo/app',
		fullPath: '/repo/app',
		projectRoot: '/repo/app',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [{ id: 'tab-1', label: 'Main', type: 'ai', logs: [], state: 'idle' }],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	} as Session;
}

function deps(overrides = {}) {
	return {
		spawnAgentForSession: vi.fn().mockResolvedValue({ success: true }),
		rightPanelRef: { current: { refreshHistoryPanel: vi.fn() } },
		processQueuedItemRef: { current: vi.fn().mockResolvedValue(undefined) },
		handleClearAgentError: vi.fn(),
		...overrides,
	};
}

function completion(overrides = {}) {
	return {
		sessionId: 'session-1',
		sessionName: 'Agent One',
		wasStopped: false,
		completedTasks: 2,
		totalTasks: 2,
		elapsedTimeMs: 0,
		documentsProcessed: 1,
		inputTokens: 10,
		outputTokens: 20,
		totalCostUsd: 0.01,
		...overrides,
	};
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('useBatchHandlers integration', () => {
	let quitRequest: (() => void | Promise<void>) | undefined;
	let unsubscribeQuit: ReturnType<typeof vi.fn>;
	let consoleLog: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		processor.options = undefined;
		processor.activeBatchSessionIds = [];
		processor.getBatchState.mockImplementation((sessionId: string) =>
			batchState({ folderPath: sessionId })
		);
		unsubscribeQuit = vi.fn();
		quitRequest = undefined;
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		window.maestro = {
			...window.maestro,
			app: {
				onQuitConfirmationRequest: vi.fn((callback: () => void) => {
					quitRequest = callback;
					return unsubscribeQuit;
				}),
				confirmQuit: vi.fn(),
				cancelQuit: vi.fn(),
			},
			groupChat: {
				...window.maestro.groupChat,
				reportAutoRunComplete: vi.fn().mockResolvedValue({ success: true }),
			},
			history: {
				...window.maestro.history,
				add: vi.fn().mockResolvedValue({ success: true }),
			},
			leaderboard: {
				...window.maestro.leaderboard,
				submit: vi.fn().mockResolvedValue({ success: false }),
			},
			settings: {
				...window.maestro.settings,
				set: vi.fn().mockResolvedValue(undefined),
			},
			symphony: {
				...window.maestro.symphony,
				complete: vi.fn().mockResolvedValue({ prUrl: 'https://example.test/pr/1' }),
				updateStatus: vi.fn().mockResolvedValue({ success: true }),
			},
		};

		useBatchStore.setState({ batchRunStates: {} } as any);
		useModalStore.setState({ modals: new Map() } as any);
		useNotificationStore.getState().clearToasts();
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			groups: [],
			sessionsLoaded: true,
			initialLoadComplete: true,
		} as any);
		useSettingsStore.setState({
			audioFeedbackEnabled: false,
			audioFeedbackCommand: '',
			autoRunStats: { ...autoRunStats },
			firstAutoRunCompleted: true,
			leaderboardRegistration: null,
			activeThemeId: 'midnight',
		} as any);
	});

	afterEach(() => {
		consoleLog.mockRestore();
		vi.restoreAllMocks();
		cleanup();
	});

	it('wires processor callbacks through real stores, history, refs, and memoized state', async () => {
		const active = session({ groupId: 'group-1' });
		processor.activeBatchSessionIds = ['worker-1'];
		processor.getBatchState.mockImplementation((sessionId: string) =>
			batchState({ folderPath: `state:${sessionId}`, isRunning: sessionId === 'worker-1' })
		);
		const harness = deps();
		useSessionStore.setState({
			sessions: [active],
			activeSessionId: active.id,
			groups: [{ id: 'group-1', name: 'Build Group' }],
		} as any);

		const { result } = renderHook(() => useBatchHandlers(harness));

		expect(processor.options.sessions).toEqual([active]);
		expect(processor.options.groups).toEqual([{ id: 'group-1', name: 'Build Group' }]);
		await processor.options.onSpawnAgent(active.id, 'Run the plan', '/repo/override');
		expect(harness.spawnAgentForSession).toHaveBeenCalledWith(
			active.id,
			'Run the plan',
			'/repo/override',
			{
				isAutoRun: true,
			}
		);
		expect(result.current.currentSessionBatchState?.folderPath).toBe('state:session-1');
		expect(result.current.activeBatchRunState.folderPath).toBe('state:worker-1');
		expect(result.current.pauseBatchOnErrorRef.current).toBe(processor.pauseBatchOnError);
		expect(result.current.getBatchStateRef.current).toBe(processor.getBatchState);

		act(() => processor.options.onUpdateSession(active.id, { name: 'Renamed Agent' }));
		expect(useSessionStore.getState().sessions[0].name).toBe('Renamed Agent');

		await act(async () => {
			await processor.options.onAddHistoryEntry({
				type: 'AUTO',
				timestamp: 123,
				summary: 'Finished',
				fullResponse: 'Done',
				projectPath: '/repo/app',
				sessionId: active.id,
				success: true,
			});
		});

		expect(window.maestro.history.add).toHaveBeenCalledWith(
			expect.objectContaining({ id: expect.any(String), summary: 'Finished' })
		);
		expect(harness.rightPanelRef.current.refreshHistoryPanel).toHaveBeenCalled();
		expect(result.current.startBatchRun).toBe(processor.startBatchRun);
	});

	it('handles completion notifications, first-run celebration, and group-chat reporting', async () => {
		useSessionStore.setState({
			sessions: [session({ groupId: 'group-1' })],
			activeSessionId: 'session-1',
			groups: [{ id: 'group-1', name: 'Build Group' }],
		} as any);
		useSettingsStore.setState({ firstAutoRunCompleted: false } as any);
		registerGroupChatAutoRun('session-1', 'chat-1', 'Agent One');
		renderHook(() => useBatchHandlers(deps()));

		act(() => {
			processor.options.onComplete(completion({ elapsedTimeMs: 1234 }));
		});

		await waitFor(() =>
			expect(window.maestro.groupChat.reportAutoRunComplete).toHaveBeenCalledWith(
				'chat-1',
				'Agent One',
				'Auto Run complete: 2/2 tasks finished across 1 document(s).'
			)
		);
		expect(useSettingsStore.getState().firstAutoRunCompleted).toBe(true);
		await delay(550);
		expect(useModalStore.getState().isOpen('firstRunCelebration')).toBe(true);
	});

	it('covers stopped and partial completion toasts plus group-chat report failures', async () => {
		useSessionStore.setState({ sessions: [session()], activeSessionId: 'session-1' } as any);
		vi.mocked(window.maestro.groupChat.reportAutoRunComplete).mockRejectedValueOnce(
			new Error('chat offline')
		);
		registerGroupChatAutoRun('session-1', 'chat-1', 'Agent One');
		renderHook(() => useBatchHandlers(deps()));

		act(() => {
			processor.options.onComplete(
				completion({ wasStopped: true, completedTasks: 1, totalTasks: 3, documentsProcessed: 2 })
			);
			processor.options.onComplete(completion({ completedTasks: 1, totalTasks: 3 }));
		});

		await waitFor(() =>
			expect(useNotificationStore.getState().toasts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'error',
						title: 'Group Chat Auto Run',
					}),
				])
			)
		);
		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'warning',
					message: 'Stopped after completing 1 of 3 tasks',
				}),
				expect.objectContaining({
					type: 'info',
					message: 'Completed 1 of 3 tasks',
				}),
				expect.objectContaining({
					type: 'error',
					title: 'Group Chat Auto Run',
					duration: 8000,
				}),
			])
		);
		expect(window.maestro.groupChat.reportAutoRunComplete).toHaveBeenCalledWith(
			'chat-1',
			'Agent One',
			'Auto Run stopped: completed 1 of 3 tasks across 2 document(s).'
		);
	});

	it('submits leaderboard updates, syncs server totals, and captures rejected submissions', async () => {
		useSessionStore.setState({ sessions: [session()], activeSessionId: 'session-1' } as any);
		useSettingsStore.setState({
			firstAutoRunCompleted: true,
			autoRunStats: {
				...autoRunStats,
				cumulativeTimeMs: 3000,
				longestRunMs: 9000,
				longestRunTimestamp: 1000,
			},
			leaderboardRegistration: {
				email: 'user@example.test',
				displayName: 'User',
				githubUsername: 'octo',
				twitterHandle: '',
				linkedinHandle: '',
				emailConfirmed: true,
				authToken: 'token-1',
			},
		} as any);
		vi.mocked(window.maestro.leaderboard.submit).mockResolvedValueOnce({
			success: true,
			requiresConfirmation: false,
			ranking: {
				cumulative: { rank: 3, previousRank: null, total: 25, improved: false },
				longestRun: { rank: 4 },
			},
			serverTotals: { cumulativeTimeMs: 9000, totalRuns: 7 },
		});
		renderHook(() => useBatchHandlers(deps()));

		act(() => {
			processor.options.onComplete(completion({ elapsedTimeMs: 1000 }));
		});

		await waitFor(() =>
			expect(window.maestro.leaderboard.submit).toHaveBeenCalledWith(
				expect.objectContaining({
					email: 'user@example.test',
					badgeName: expect.any(String),
					cumulativeTimeMs: 4000,
					totalRuns: 1,
					theme: 'midnight',
					authToken: 'token-1',
					deltaMs: 1000,
				})
			)
		);
		await waitFor(() => expect(useSettingsStore.getState().autoRunStats.totalRuns).toBe(7));
		expect(useSettingsStore.getState().leaderboardRegistration?.lastSubmissionAt).toEqual(
			expect.any(Number)
		);

		vi.mocked(window.maestro.leaderboard.submit).mockRejectedValueOnce(new Error('network'));
		act(() => {
			processor.options.onComplete(completion({ elapsedTimeMs: 1000 }));
		});
		await waitFor(() =>
			expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
				extra: expect.objectContaining({ operation: 'leaderboard-submit' }),
			})
		);
	});

	it('handles badge ovations and skips leaderboard submission without an auth token', async () => {
		useSessionStore.setState({ sessions: [session()], activeSessionId: 'session-1' } as any);
		useSettingsStore.setState({
			firstAutoRunCompleted: true,
			autoRunStats: {
				...autoRunStats,
				cumulativeTimeMs: 15 * 60 * 1000,
				longestRunMs: 5000,
			},
			leaderboardRegistration: {
				email: 'user@example.test',
				displayName: 'User',
				emailConfirmed: true,
				authToken: '',
			},
		} as any);
		renderHook(() => useBatchHandlers(deps()));

		act(() => {
			processor.options.onComplete(completion({ elapsedTimeMs: 1000 }));
		});

		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'Leaderboard submission skipped: no auth token',
			undefined,
			undefined
		);
		expect(window.maestro.leaderboard.submit).not.toHaveBeenCalled();
		await delay(550);
		expect(useModalStore.getState().isOpen('standingOvation')).toBe(true);
		expect(useModalStore.getState().getData('standingOvation')).toMatchObject({
			isNewRecord: false,
			recordTimeMs: 5000,
		});
	});

	it('formats leaderboard rank movement, steady rank, lower rank, and personal best messages', async () => {
		useSessionStore.setState({ sessions: [session()], activeSessionId: 'session-1' } as any);
		useSettingsStore.setState({
			firstAutoRunCompleted: true,
			autoRunStats: {
				...autoRunStats,
				cumulativeTimeMs: 15 * 60 * 1000,
				currentBadgeLevel: 1,
				lastBadgeUnlockLevel: 1,
				longestRunMs: 1000,
				longestRunTimestamp: 1000,
				totalRuns: 2,
			},
			leaderboardRegistration: {
				email: 'user@example.test',
				displayName: 'User',
				emailConfirmed: true,
				authToken: 'token-1',
			},
		} as any);
		vi.mocked(window.maestro.leaderboard.submit)
			.mockResolvedValueOnce({
				success: true,
				requiresConfirmation: false,
				ranking: {
					cumulative: { rank: 3, previousRank: 5, total: 25, improved: true },
					longestRun: { rank: 2 },
				},
			})
			.mockResolvedValueOnce({
				success: true,
				requiresConfirmation: false,
				ranking: {
					cumulative: { rank: 3, previousRank: 3, total: 25, improved: false },
				},
			})
			.mockResolvedValueOnce({
				success: true,
				requiresConfirmation: false,
				ranking: {
					cumulative: { rank: 6, previousRank: 3, total: 25, improved: false },
				},
			});
		renderHook(() => useBatchHandlers(deps()));

		act(() => {
			processor.options.onComplete(completion({ elapsedTimeMs: 2000 }));
			processor.options.onComplete(completion({ elapsedTimeMs: 1000 }));
			processor.options.onComplete(completion({ elapsedTimeMs: 1000 }));
		});

		await waitFor(() => expect(window.maestro.leaderboard.submit).toHaveBeenCalledTimes(3));
		await waitFor(() =>
			expect(
				useNotificationStore
					.getState()
					.toasts.filter((toast) => toast.title === 'Leaderboard Updated')
					.map((toast) => toast.message)
			).toEqual([
				'You moved up 2 spots! Now #3 (was #5) | New personal best! #2 on longest runs!',
				"You're holding steady at #3",
				"You're now #6 of 25",
			])
		);
		expect(window.maestro.leaderboard.submit).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				longestRunDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			})
		);
		await delay(550);
		expect(useModalStore.getState().getData('standingOvation')).toMatchObject({
			isNewRecord: true,
			recordTimeMs: 2000,
		});
	});

	it('auto-finalizes Symphony contributions and preserves manual fallback paths', async () => {
		useSessionStore.setState({
			sessions: [
				session({
					symphonyMetadata: {
						isSymphonySession: true,
						contributionId: 'contrib-1',
						issueNumber: 42,
						issueTitle: 'Fix launch',
					},
				} as any),
			],
			activeSessionId: 'session-1',
		} as any);
		vi.mocked(window.maestro.symphony.complete)
			.mockResolvedValueOnce({ prUrl: 'https://example.test/pr/1' })
			.mockResolvedValueOnce({ error: 'draft only' })
			.mockRejectedValueOnce(new Error('gh failed'));
		renderHook(() => useBatchHandlers(deps()));

		act(() => {
			processor.options.onComplete(completion({ elapsedTimeMs: 0 }));
			processor.options.onComplete(completion({ elapsedTimeMs: 0 }));
			processor.options.onComplete(completion({ elapsedTimeMs: 0 }));
		});

		await waitFor(() => expect(window.maestro.symphony.complete).toHaveBeenCalledTimes(3), {
			timeout: 2600,
		});
		expect(window.maestro.history.add).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Symphony PR ready for review: https://example.test/pr/1',
			})
		);
		expect(window.maestro.symphony.updateStatus).toHaveBeenCalledWith({
			contributionId: 'contrib-1',
			status: 'completed',
		});
		expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { operation: 'symphony-auto-finalize', contributionId: 'contrib-1' },
		});
	});

	it('routes PR results and queued items through session, modal, and queue stores', () => {
		const queuedMessage: QueuedItem = {
			id: 'queue-1',
			timestamp: 1,
			tabId: 'tab-1',
			type: 'message',
			text: 'continue',
			images: ['img'],
		};
		const queuedCommand: QueuedItem = {
			id: 'queue-2',
			timestamp: 2,
			tabId: 'missing-tab',
			type: 'command',
			command: '/commit',
		};
		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		useSessionStore.setState({
			sessions: [
				session({ groupId: 'group-1', executionQueue: [queuedMessage] }),
				session({ id: 'no-tab', aiTabs: [], activeTabId: '', executionQueue: [queuedCommand] }),
			],
			activeSessionId: 'session-1',
			groups: [{ id: 'group-1', name: 'Build Group' }],
		} as any);
		renderHook(() =>
			useBatchHandlers(deps({ processQueuedItemRef: { current: processQueuedItem } }))
		);

		act(() => {
			processor.options.onPRResult({
				sessionId: 'session-1',
				sessionName: 'Agent One',
				success: true,
				prUrl: 'https://example.test/pr/2',
			});
			processor.options.onPRResult({
				sessionId: 'missing-session',
				sessionName: 'Other',
				success: false,
				error: 'gh auth failed',
			});
			processor.options.onProcessQueueAfterCompletion('session-1');
			processor.options.onProcessQueueAfterCompletion('no-tab');
		});

		expect(processQueuedItem).toHaveBeenCalledWith('session-1', queuedMessage);
		expect(processQueuedItem).toHaveBeenCalledWith('no-tab', queuedCommand);
		const updated = useSessionStore.getState().sessions;
		expect(updated.find((stored) => stored.id === 'session-1')).toMatchObject({
			state: 'busy',
			activeTabId: 'tab-1',
			executionQueue: [],
		});
		expect(updated.find((stored) => stored.id === 'session-1')?.aiTabs[0].logs[0]).toMatchObject({
			source: 'user',
			text: 'continue',
			images: ['img'],
		});
		expect(updated.find((stored) => stored.id === 'no-tab')).toMatchObject({
			state: 'busy',
			executionQueue: [],
		});
	});

	it('exposes stop, kill, paused-error controls, stat sync, and quit confirmation', async () => {
		const harness = deps();
		useSessionStore.setState({
			sessions: [
				session(),
				session({ id: 'paused-session', name: 'Paused Agent' }),
				session({ id: 'busy-agent', state: 'busy', busySource: 'ai' }),
			],
			activeSessionId: 'session-1',
		} as any);
		const { result, unmount } = renderHook(() => useBatchHandlers(harness));

		act(() => result.current.handleStopBatchRun());
		const confirmData = useModalStore.getState().getData('confirm') as { onConfirm: () => void };
		confirmData.onConfirm();
		expect(processor.stopBatchRun).toHaveBeenCalledWith('session-1');

		await act(async () => {
			await result.current.handleKillBatchRun('session-1');
		});
		expect(processor.killBatchRun).toHaveBeenCalledWith('session-1');

		useBatchStore.setState({
			batchRunStates: {
				'session-1': batchState({ errorPaused: true }),
				'paused-session': batchState({ errorPaused: true }),
			},
		} as any);
		act(() => {
			result.current.handleSkipCurrentDocument();
			result.current.handleResumeAfterError();
			result.current.handleAbortBatchOnError();
		});
		expect(processor['skipCurrentDocument']).toHaveBeenCalledWith('session-1');
		expect(processor.resumeAfterError).toHaveBeenCalledWith('session-1');
		expect(processor.abortBatchOnError).toHaveBeenCalledWith('session-1');
		expect(harness.handleClearAgentError).toHaveBeenCalledWith('session-1');

		useBatchStore.setState({
			batchRunStates: { 'paused-session': batchState({ errorPaused: true }) },
		} as any);
		act(() => result.current.handleResumeAfterError());
		expect(processor.resumeAfterError).toHaveBeenLastCalledWith('paused-session');

		act(() =>
			result.current.handleSyncAutoRunStats({
				cumulativeTimeMs: 9000,
				totalRuns: 3,
				currentBadgeLevel: 2,
				longestRunMs: 5000,
				longestRunTimestamp: 12345,
			})
		);
		expect(useSettingsStore.getState().autoRunStats).toMatchObject({
			cumulativeTimeMs: 9000,
			totalRuns: 3,
			currentBadgeLevel: 2,
			lastBadgeUnlockLevel: 2,
			lastAcknowledgedBadgeLevel: 2,
		});

		await act(async () => {
			await quitRequest?.();
		});
		expect(useModalStore.getState().isOpen('quitConfirm')).toBe(true);

		useSessionStore.setState({ sessions: [session()], activeSessionId: 'session-1' } as any);
		useModalStore.setState({ modals: new Map() } as any);
		processor.getBatchState.mockReturnValue(batchState({ isRunning: false }));
		await act(async () => {
			await quitRequest?.();
		});
		expect(window.maestro.app.confirmQuit).toHaveBeenCalled();

		unmount();
		expect(unsubscribeQuit).toHaveBeenCalled();
	});

	it('leaves no-op controls quiet when no session or paused error exists', () => {
		const harness = deps();
		const { result } = renderHook(() => useBatchHandlers(harness));

		act(() => {
			result.current.handleStopBatchRun();
			result.current.handleSkipCurrentDocument();
			result.current.handleResumeAfterError();
			result.current.handleAbortBatchOnError();
		});

		expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		expect(processor.stopBatchRun).not.toHaveBeenCalled();
		expect(processor.skipCurrentDocument).not.toHaveBeenCalled();
		expect(processor.resumeAfterError).not.toHaveBeenCalled();
		expect(processor.abortBatchOnError).not.toHaveBeenCalled();
		expect(harness.handleClearAgentError).not.toHaveBeenCalled();
	});

	it('skips quit subscription when the app quit hook is unavailable', () => {
		window.maestro.app = {} as any;

		renderHook(() => useBatchHandlers(deps()));

		expect(unsubscribeQuit).not.toHaveBeenCalled();
	});
});
