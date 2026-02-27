/**
 * Tests for useSummarizeAndContinue — handleSummarizeAndContinue (Tier 3E)
 *
 * Tests the high-level handler that validates, runs summarization,
 * updates session state, and shows toast notifications.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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

import { useSummarizeAndContinue } from '../../../renderer/hooks/agent/useSummarizeAndContinue';
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

		await act(async () => {
			result.current.handleSummarizeAndContinue();
			// Allow the .then() promise chain to resolve
			await vi.waitFor(() => {
				expect(contextSummarizationService.summarizeContext).toHaveBeenCalled();
			});
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
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		await act(async () => {
			result.current.handleSummarizeAndContinue();
			await vi.waitFor(() => {
				expect(createTabAtPosition).toHaveBeenCalled();
			});
		});

		// Session should have been updated in the store via setSessions
		const updatedSessions = useSessionStore.getState().sessions;
		expect(updatedSessions.length).toBeGreaterThan(0);
	});

	it('shows success toast on success', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		await act(async () => {
			result.current.handleSummarizeAndContinue();
			await vi.waitFor(() => {
				expect(notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'success',
						title: 'Context Compacted',
					})
				);
			});
		});
	});

	it('clears tab state on success', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		const { result } = renderHook(() => useSummarizeAndContinue(session));

		await act(async () => {
			result.current.handleSummarizeAndContinue();
			await vi.waitFor(() => {
				expect(createTabAtPosition).toHaveBeenCalled();
			});
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

		await act(async () => {
			result.current.handleSummarizeAndContinue('tab-2');
			await vi.waitFor(() => {
				expect(contextSummarizationService.summarizeContext).toHaveBeenCalled();
			});
		});

		expect(contextSummarizationService.summarizeContext).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceTabId: 'tab-2',
			}),
			expect.any(Array),
			expect.any(Function)
		);
	});
});
