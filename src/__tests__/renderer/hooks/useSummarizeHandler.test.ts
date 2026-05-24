/**
 * Tests for useSummarizeAndContinue — handleSummarizeAndContinue (Tier 3E)
 *
 * Tests the high-level handler that validates, runs summarization,
 * updates session state, and shows toast notifications.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../../renderer/services/contextSummarizer', () => ({
	contextSummarizationService: {
		canSummarize: vi.fn().mockReturnValue(true),
		getMinContextUsagePercent: vi.fn().mockReturnValue(50),
		summarizeContext: vi.fn().mockResolvedValue({
			summarizedLogs: [{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'compacted' }],
			originalTokens: 10000,
			compactedTokens: 3000,
		}),
		formatCompactedTabName: vi.fn((name: string) => `${name || 'Tab'} Compacted`),
		cancelSummarization: vi.fn(),
	},
}));

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

vi.mock('../../../renderer/utils/tabHelpers', async () => {
	const actual = await vi.importActual('../../../renderer/utils/tabHelpers');
	return {
		...actual,
		createTabAtPosition: vi.fn((session: any, options: any) => {
			const newTab = {
				id: 'new-tab-1',
				agentSessionId: null,
				name: options.name,
				starred: false,
				logs: options.logs || [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
				saveToHistory: options.saveToHistory ?? true,
			};
			return {
				tab: newTab,
				session: {
					...session,
					aiTabs: [...session.aiTabs, newTab],
				},
			};
		}),
	};
});

import {
	createSummarizeSystemLogEntry,
	useSummarizeAndContinue,
} from '../../../renderer/hooks/agent/useSummarizeAndContinue';
import { contextSummarizationService } from '../../../renderer/services/contextSummarizer';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createTabAtPosition } from '../../../renderer/utils/tabHelpers';
import { useOperationStore } from '../../../renderer/stores/operationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, AITab } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-1',
		name: 'Tab 1',
		starred: false,
		logs: [
			{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'hello' },
			{ id: 'log-2', timestamp: Date.now(), source: 'assistant', text: 'world' },
		],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		saveToHistory: true,
		...overrides,
	} as AITab;
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/projects/test',
		fullPath: '/projects/test',
		projectRoot: '/projects/test',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 75,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [createMockTab()],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

async function startSummarizeWithAct(
	hook: { current: ReturnType<typeof useSummarizeAndContinue> },
	tabId: string
) {
	let summarizeResult: Awaited<
		ReturnType<ReturnType<typeof useSummarizeAndContinue>['startSummarize']>
	> = null;

	await act(async () => {
		summarizeResult = await hook.current.startSummarize(tabId);
	});

	return summarizeResult;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset stores
	useOperationStore.getState().resetAll();
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
	});

	// Default: canSummarize returns true
	(contextSummarizationService.canSummarize as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('handleSummarizeAndContinue (Tier 3E)', () => {
	it('formats system log entries for success and non-success results', () => {
		expect(createSummarizeSystemLogEntry('Plain message').text).toBe('Plain message');
		expect(
			createSummarizeSystemLogEntry('Failed message', {
				success: false,
				originalTokens: 100,
				compactedTokens: 100,
				reductionPercent: 0,
			}).text
		).toBe('Failed message');
		expect(
			createSummarizeSystemLogEntry('Compacted message', {
				success: true,
				reductionPercent: 25,
			}).text
		).toContain('Token reduction: 25% (~0 → ~0 tokens)');
	});

	it('returns when no session is provided', async () => {
		const { result } = renderHook(() => useSummarizeAndContinue(null));

		await act(async () => {
			result.current.handleSummarizeAndContinue();
		});

		expect(contextSummarizationService.canSummarize).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('returns when inputMode is terminal', async () => {
		const session = createMockSession({ inputMode: 'terminal' });

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		await act(async () => {
			result.current.handleSummarizeAndContinue();
		});

		expect(contextSummarizationService.canSummarize).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('shows warning toast when canSummarize fails', async () => {
		(contextSummarizationService.canSummarize as ReturnType<typeof vi.fn>).mockReturnValue(false);

		const session = createMockSession();

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		await act(async () => {
			result.current.handleSummarizeAndContinue();
		});

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'warning',
				title: 'Cannot Compact',
			})
		);
	});

	it('calls startSummarize with the active tab id', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(contextSummarizationService.summarizeContext).toHaveBeenCalled();
		});

		expect(contextSummarizationService.summarizeContext).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceSessionId: 'session-1',
				sourceTabId: 'tab-1',
			}),
			expect.any(Array),
			expect.any(Function)
		);
	});

	it('updates session on success', async () => {
		const session = createMockSession();
		const otherSession = createMockSession({
			id: 'session-2',
			name: 'Other Agent',
			activeTabId: 'other-tab',
			aiTabs: [createMockTab({ id: 'other-tab', name: 'Other Tab' })],
		});
		useSessionStore.setState({
			sessions: [otherSession, session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(createTabAtPosition).toHaveBeenCalled();
		});

		// Session should have been updated in the store via setSessions
		const updatedSessions = useSessionStore.getState().sessions;
		expect(updatedSessions.length).toBeGreaterThan(0);

		const updatedSession = updatedSessions.find((s) => s.id === session.id);
		const updatedOtherSession = updatedSessions.find((s) => s.id === otherSession.id);
		expect(updatedSession).toBeDefined();
		expect(updatedOtherSession).toBe(otherSession);
		// Should have a new tab added by createTabAtPosition
		expect(updatedSession!.aiTabs.length).toBeGreaterThan(session.aiTabs.length);
		// Active tab should be switched to the new tab
		expect(updatedSession!.activeTabId).toBe('new-tab-1');
	});

	it('does not duplicate a compacted tab that already exists in the live session', async () => {
		const compactedTab = createMockTab({
			id: 'new-tab-1',
			name: 'Tab 1 Compacted',
			logs: [],
		});
		const session = createMockSession();
		const liveSession = createMockSession({
			aiTabs: [...session.aiTabs, compactedTab],
		});
		useSessionStore.setState({
			sessions: [liveSession],
			activeSessionId: session.id,
		});
		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			summarizedLogs: [],
			originalTokens: undefined,
			compactedTokens: undefined,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					message: 'Reduced context by 0%. Click to view the new tab.',
				})
			);
		});

		const updatedSession = useSessionStore.getState().sessions[0];
		expect(updatedSession.aiTabs.filter((tab) => tab.id === 'new-tab-1')).toHaveLength(1);
		expect(updatedSession.activeTabId).toBe('new-tab-1');
		expect(updatedSession.aiTabs[0].logs.at(-1)?.text).toContain('Token reduction: NaN%');
	});

	it('inserts a compacted tab at the end when the source tab is absent from the live session', async () => {
		const session = createMockSession();
		const liveSession = createMockSession({
			aiTabs: [createMockTab({ id: 'other-tab', name: 'Other Tab' })],
			activeTabId: 'other-tab',
		});
		useSessionStore.setState({
			sessions: [liveSession],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(createTabAtPosition).toHaveBeenCalled();
		});

		const updatedSession = useSessionStore.getState().sessions[0];
		expect(updatedSession.aiTabs.map((tab) => tab.id)).toEqual(['other-tab', 'new-tab-1']);
		expect(updatedSession.activeTabId).toBe('new-tab-1');
	});

	it('shows success toast on success', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'success',
					title: 'Context Compacted',
				})
			);
		});
	});

	it('clears tab state on success', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(createTabAtPosition).toHaveBeenCalled();
		});

		// After success the tab state should be cleared
		const tabState = useOperationStore.getState().summarizeStates.get('tab-1');
		expect(tabState).toBeUndefined();
	});

	it('uses explicit tabId parameter when provided', async () => {
		const tab2 = createMockTab({ id: 'tab-2', name: 'Tab 2' });
		const session = createMockSession({
			aiTabs: [createMockTab(), tab2],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue('tab-2');
		});
		await waitFor(() => {
			expect(contextSummarizationService.summarizeContext).toHaveBeenCalled();
		});

		expect(contextSummarizationService.summarizeContext).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceTabId: 'tab-2',
			}),
			expect.any(Array),
			expect.any(Function)
		);
	});

	it('shows error toast when summarization fails', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		// Make summarizeContext reject
		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error('Summarization failed'));

		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Compaction Failed',
				})
			);
		});

		// createTabAtPosition should NOT have been called
		expect(createTabAtPosition).not.toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	it('startSummarize returns null for missing source tab, too-small context, and active duplicate work', async () => {
		const session = createMockSession();
		const { result } = renderHook(() => useSummarizeAndContinue(session));
		const nullSessionHook = renderHook(() => useSummarizeAndContinue(null));

		await expect(startSummarizeWithAct(nullSessionHook.result, 'tab-1')).resolves.toBeNull();

		await expect(startSummarizeWithAct(result, 'missing-tab')).resolves.toBeNull();

		(contextSummarizationService.canSummarize as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			false
		);
		await expect(startSummarizeWithAct(result, 'tab-1')).resolves.toBeNull();

		act(() => {
			useOperationStore.getState().setSummarizeTabState('tab-1', {
				state: 'summarizing',
				progress: null,
				result: null,
				error: null,
				startTime: 123,
			});
		});
		await expect(startSummarizeWithAct(result, 'tab-1')).resolves.toBeNull();
	});

	it('startSummarize completes with progress, compacted tab, and system log metadata', async () => {
		const session = createMockSession({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			customPath: '/custom/agent',
			customArgs: '--flag',
			customEnvVars: { TEST: '1' },
		});
		const { result } = renderHook(() => useSummarizeAndContinue(session));

		let progressCallback: ((progress: any) => void) | undefined;
		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockImplementationOnce(async (_config, _logs, onProgress) => {
			progressCallback = onProgress;
			onProgress({ stage: 'summarizing', progress: 45, message: 'Working' });
			return {
				summarizedLogs: [{ id: 'compact', timestamp: Date.now(), source: 'user', text: 'compact' }],
				originalTokens: 10000,
				compactedTokens: 2500,
			};
		});

		const summarizeResult = await startSummarizeWithAct(result, 'tab-1');

		expect(progressCallback).toBeDefined();
		expect(contextSummarizationService.summarizeContext).toHaveBeenCalledWith(
			expect.objectContaining({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				customPath: '/custom/agent',
				customArgs: '--flag',
				customEnvVars: { TEST: '1' },
			}),
			expect.any(Array),
			expect.any(Function)
		);
		expect(summarizeResult).toMatchObject({
			newTabId: 'new-tab-1',
			systemLogEntry: expect.objectContaining({
				source: 'system',
				text: expect.stringContaining('Token reduction: 75%'),
			}),
		});
		expect(useOperationStore.getState().summarizeStates.get('tab-1')).toMatchObject({
			state: 'complete',
			progress: expect.objectContaining({ progress: 100 }),
			result: expect.objectContaining({ reductionPercent: 75 }),
		});
	});

	it('startSummarize drops progress and result after cancellation', async () => {
		const session = createMockSession();
		const { result } = renderHook(() => useSummarizeAndContinue(session));
		let progressCallback: ((progress: any) => void) | undefined;
		let resolveSummary:
			| ((value: {
					summarizedLogs: AITab['logs'];
					originalTokens: number;
					compactedTokens: number;
			  }) => void)
			| undefined;

		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockImplementationOnce(async (_config, _logs, onProgress) => {
			progressCallback = onProgress;
			return new Promise((resolve) => {
				resolveSummary = resolve;
			});
		});

		let summarizePromise: ReturnType<ReturnType<typeof useSummarizeAndContinue>['startSummarize']>;
		await act(async () => {
			summarizePromise = result.current.startSummarize('tab-1');
		});
		await waitFor(() => {
			expect(useOperationStore.getState().summarizeStates.get('tab-1')).toMatchObject({
				state: 'summarizing',
			});
		});
		await waitFor(() => {
			expect(progressCallback).toBeDefined();
		});

		act(() => {
			result.current.cancelTab('tab-1');
			progressCallback?.({ stage: 'summarizing', progress: 90, message: 'Ignored' });
		});
		resolveSummary?.({
			summarizedLogs: [{ id: 'compact', timestamp: Date.now(), source: 'user', text: 'compact' }],
			originalTokens: 100,
			compactedTokens: 50,
		});

		await expect(summarizePromise!).resolves.toBeNull();
		expect(createTabAtPosition).not.toHaveBeenCalled();
		expect(result.current.getTabSummarizeState('tab-1')).toBeNull();
	});

	it('ignores progress emitted after cancellation has already been requested', async () => {
		const session = createMockSession();
		const { result } = renderHook(() => useSummarizeAndContinue(session));
		let cancelBeforeProgress: (() => void) | undefined;

		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockImplementationOnce(async (_config, _logs, onProgress) => {
			cancelBeforeProgress?.();
			onProgress({ stage: 'summarizing', progress: 90, message: 'Ignored' });
			return {
				summarizedLogs: [{ id: 'compact', timestamp: Date.now(), source: 'user', text: 'compact' }],
				originalTokens: 100,
				compactedTokens: 50,
			};
		});
		cancelBeforeProgress = () => result.current.cancelTab('tab-1');

		await expect(startSummarizeWithAct(result, 'tab-1')).resolves.toBeNull();

		expect(createTabAtPosition).not.toHaveBeenCalled();
		expect(result.current.getTabSummarizeState('tab-1')).toBeNull();
	});

	it('does not record an error state when summarization fails after cancellation', async () => {
		const session = createMockSession();
		const { result } = renderHook(() => useSummarizeAndContinue(session));
		let cancelBeforeFailure: (() => void) | undefined;

		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockImplementationOnce(async () => {
			cancelBeforeFailure?.();
			throw new Error('Canceled request failed later');
		});
		cancelBeforeFailure = () => result.current.cancelTab('tab-1');

		await expect(startSummarizeWithAct(result, 'tab-1')).resolves.toBeNull();

		expect(createTabAtPosition).not.toHaveBeenCalled();
		expect(result.current.getTabSummarizeState('tab-1')).toBeNull();
	});

	it('startSummarize records error state for null summary result and tab creation failure', async () => {
		const session = createMockSession();
		const { result } = renderHook(() => useSummarizeAndContinue(session));

		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce(null);
		await expect(startSummarizeWithAct(result, 'tab-1')).resolves.toBeNull();
		expect(useOperationStore.getState().summarizeStates.get('tab-1')).toMatchObject({
			state: 'error',
			error: 'Summarization returned no result',
		});

		act(() => {
			result.current.clearTabState('tab-1');
		});
		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			summarizedLogs: [],
			originalTokens: 100,
			compactedTokens: 50,
		});
		(createTabAtPosition as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

		await expect(startSummarizeWithAct(result, 'tab-1')).resolves.toBeNull();
		expect(useOperationStore.getState().summarizeStates.get('tab-1')).toMatchObject({
			state: 'error',
			error: 'Failed to create compacted tab',
		});
	});

	it('cancelTab, cancel, and clearTabState clear operation state and cancellation tracking', () => {
		const session = createMockSession({
			aiTabs: [createMockTab({ id: 'tab-1' }), createMockTab({ id: 'tab-2' })],
		});
		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			useOperationStore.getState().setSummarizeTabState('tab-1', {
				state: 'summarizing',
				progress: null,
				result: null,
				error: null,
				startTime: 123,
			});
			useOperationStore.getState().setSummarizeTabState('tab-2', {
				state: 'summarizing',
				progress: null,
				result: null,
				error: null,
				startTime: 456,
			});
		});

		expect(result.current.getTabSummarizeState('tab-1')).toMatchObject({ state: 'summarizing' });

		act(() => {
			result.current.cancelTab('tab-1');
		});
		expect(contextSummarizationService.cancelSummarization).toHaveBeenCalled();
		expect(result.current.getTabSummarizeState('tab-1')).toBeNull();

		act(() => {
			result.current.cancel();
		});
		expect(useOperationStore.getState().summarizeStates.size).toBe(0);

		act(() => {
			useOperationStore.getState().setSummarizeTabState('tab-2', {
				state: 'error',
				progress: null,
				result: null,
				error: 'failed',
				startTime: 789,
			});
		});
		act(() => {
			result.current.clearTabState('tab-2');
		});
		expect(result.current.getTabSummarizeState('tab-2')).toBeNull();
	});

	it('handleSummarizeAndContinue reports non-Error summarization failures', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});
		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockImplementationOnce(() => {
			throw 'unexpected failure';
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		act(() => {
			result.current.handleSummarizeAndContinue();
		});
		await waitFor(() => {
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					message: 'Failed to compact context. Check the tab for details.',
				})
			);
		});

		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it('handleSummarizeAndContinue reports unexpected session update failures', async () => {
		const session = createMockSession();
		const originalSetSessions = useSessionStore.getState().setSessions;
		const storeError = new Error('store write failed');
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
			setSessions: vi.fn(() => {
				throw storeError;
			}),
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const { result } = renderHook(() => useSummarizeAndContinue(session));

			act(() => {
				result.current.handleSummarizeAndContinue();
			});
			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith(
					'[handleSummarizeAndContinue] Unexpected error:',
					storeError
				);
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					message: 'An unexpected error occurred during compaction.',
					sessionId: 'session-1',
					tabId: 'tab-1',
				})
			);
			expect(result.current.getTabSummarizeState('tab-1')).toBeNull();
		} finally {
			useSessionStore.setState({ setSessions: originalSetSessions });
			consoleError.mockRestore();
		}
	});
});
