/**
 * Tests for useSummarizeAndContinue - handleSummarizeAndContinue (Tier 3E)
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
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// ============================================================================
// Helpers
// ============================================================================

function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return createMockAITab({
		agentSessionId: 'agent-session-1',
		name: 'Tab 1',
		logs: [
			{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'hello' },
			{ id: 'log-2', timestamp: Date.now(), source: 'assistant', text: 'world' },
		],
		saveToHistory: true,
		...overrides,
	});
}

// Thin wrapper: pre-populates an AI tab and raises contextUsage above the
// summarization threshold so the summarize handler will actually run.
function createMockSession(overrides: Partial<Session> = {}): Session {
	return baseCreateMockSession({
		cwd: '/projects/test',
		fullPath: '/projects/test',
		projectRoot: '/projects/test',
		contextUsage: 75,
		aiTabs: [createMockTab()],
		activeTabId: 'tab-1',
		...overrides,
	});
}

function seedActiveSession(session: Session | null) {
	if (session) {
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		} as any);
	} else {
		useSessionStore.setState({
			sessions: [],
			activeSessionId: null,
		} as any);
	}
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
	it('summarizes with the source native owner and pins the continuation', async () => {
		const tab = createMockTab({
			tabProvider: 'codex',
			pendingTranslation: 'opencode',
			providerSessions: { opencode: { agentSessionId: 'native' } },
		});
		const session = createMockSession({
			aiTabs: [tab],
			activeTabId: tab.id,
			customPath: '/claude',
			customEnvVars: { CLAUDE: 'yes' },
			providerOverrides: { opencode: { customPath: '/opencode', customEnvVars: { OPEN: 'yes' } } },
		});
		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());
		let summary: Awaited<ReturnType<typeof result.current.startSummarize>>;
		await act(async () => {
			summary = await result.current.startSummarize(tab.id);
		});
		expect(contextSummarizationService.summarizeContext).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'opencode',
				customPath: '/opencode',
				customEnvVars: { OPEN: 'yes' },
				claudeTokenSource: {},
			}),
			tab.logs,
			expect.any(Function)
		);
		expect(
			summary!.updatedSession.aiTabs.find((t) => t.id === summary!.newTabId)?.tabProvider
		).toBe('opencode');
		expect(session.toolType).toBe('claude-code');
	});

	it('returns when no session is provided', async () => {
		seedActiveSession(null);
		const { result } = renderHook(() => useSummarizeAndContinue());

		await act(async () => {
			result.current.handleSummarizeAndContinue();
		});

		expect(contextSummarizationService.canSummarize).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('returns when inputMode is terminal', async () => {
		const session = createMockSession({ inputMode: 'terminal' });

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

		await act(async () => {
			result.current.handleSummarizeAndContinue();
		});

		expect(contextSummarizationService.canSummarize).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('shows warning toast when canSummarize fails', async () => {
		(contextSummarizationService.canSummarize as ReturnType<typeof vi.fn>).mockReturnValue(false);

		const session = createMockSession();

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

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

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

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

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

		await act(async () => {
			result.current.handleSummarizeAndContinue();
			await vi.waitFor(() => {
				expect(createTabAtPosition).toHaveBeenCalled();
			});
		});

		// Session should have been updated in the store via setSessions
		const updatedSessions = useSessionStore.getState().sessions;
		expect(updatedSessions.length).toBeGreaterThan(0);

		const updatedSession = updatedSessions.find((s) => s.id === session.id);
		expect(updatedSession).toBeDefined();
		// Should have a new tab added by createTabAtPosition
		expect(updatedSession!.aiTabs.length).toBeGreaterThan(session.aiTabs.length);
		// Active tab should be switched to the new tab
		expect(updatedSession!.activeTabId).toBe('new-tab-1');
	});

	it('shows success toast on success', async () => {
		const session = createMockSession();
		useSessionStore.setState({
			sessions: [session],
			activeSessionId: session.id,
		});

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

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

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

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

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

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

		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

		await act(async () => {
			result.current.handleSummarizeAndContinue();
			await vi.waitFor(() => {
				expect(notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'error',
						title: 'Compaction Failed',
					})
				);
			});
		});

		// createTabAtPosition should NOT have been called
		expect(createTabAtPosition).not.toHaveBeenCalled();

		consoleSpy.mockRestore();
	});
});

// ============================================================================
// summarizeTab - the core behind handleSummarizeAndContinue, also run by
// `maestro-cli tab compact` for any agent's tab.
// ============================================================================

describe('summarizeTab', () => {
	it('compacts a tab of an agent that is not on screen and reports the new tab', async () => {
		const onScreen = createMockSession({ id: 'session-on-screen' });
		const other = createMockSession({ id: 'session-2' });
		useSessionStore.setState({ sessions: [onScreen, other], activeSessionId: onScreen.id });
		const { result } = renderHook(() => useSummarizeAndContinue());

		let outcome: Awaited<ReturnType<typeof result.current.summarizeTab>> | undefined;
		await act(async () => {
			outcome = await result.current.summarizeTab('session-2', 'tab-1');
		});

		expect(contextSummarizationService.summarizeContext).toHaveBeenCalledWith(
			expect.objectContaining({ sourceSessionId: 'session-2', sourceTabId: 'tab-1' }),
			expect.any(Array),
			expect.any(Function)
		);
		expect(outcome).toEqual({
			success: true,
			sessionId: 'session-2',
			tabId: 'tab-1',
			newTabId: 'new-tab-1',
			reductionPercent: 70,
		});
		const updated = useSessionStore.getState().sessions.find((s) => s.id === 'session-2');
		expect(updated!.activeTabId).toBe('new-tab-1');
		expect(useSessionStore.getState().activeSessionId).toBe('session-on-screen');
	});

	it('keeps the source tab selected and skips the success toast in the background', async () => {
		const session = createMockSession();
		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

		let outcome: Awaited<ReturnType<typeof result.current.summarizeTab>> | undefined;
		await act(async () => {
			outcome = await result.current.summarizeTab(session.id, 'tab-1', { background: true });
		});

		expect(outcome).toMatchObject({ success: true, newTabId: 'new-tab-1' });
		const updated = useSessionStore.getState().sessions.find((s) => s.id === session.id);
		expect(updated!.aiTabs.map((t) => t.id)).toEqual(['tab-1', 'new-tab-1']);
		expect(updated!.activeTabId).toBe('tab-1');
		expect(notifyToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
	});

	it('answers an unknown agent without running anything', async () => {
		seedActiveSession(createMockSession());
		const { result } = renderHook(() => useSummarizeAndContinue());

		let outcome: Awaited<ReturnType<typeof result.current.summarizeTab>> | undefined;
		await act(async () => {
			outcome = await result.current.summarizeTab('ghost', 'tab-1');
		});

		expect(outcome).toEqual({ success: false, error: 'Agent not found: ghost' });
		expect(contextSummarizationService.summarizeContext).not.toHaveBeenCalled();
	});

	it('returns the failure the toast shows', async () => {
		(
			contextSummarizationService.summarizeContext as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error('provider exploded'));
		const session = createMockSession();
		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

		let outcome: Awaited<ReturnType<typeof result.current.summarizeTab>> | undefined;
		await act(async () => {
			outcome = await result.current.summarizeTab(session.id, 'tab-1');
		});

		expect(outcome).toEqual({
			success: false,
			error: 'Failed to compact context: provider exploded',
			sessionId: session.id,
			tabId: 'tab-1',
		});
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', title: 'Compaction Failed' })
		);
	});

	it('returns the too-small refusal', async () => {
		(contextSummarizationService.canSummarize as ReturnType<typeof vi.fn>).mockReturnValue(false);
		const session = createMockSession();
		seedActiveSession(session);
		const { result } = renderHook(() => useSummarizeAndContinue());

		let outcome: Awaited<ReturnType<typeof result.current.summarizeTab>> | undefined;
		await act(async () => {
			outcome = await result.current.summarizeTab(session.id, 'tab-1');
		});

		expect(outcome).toMatchObject({ success: false, error: expect.stringContaining('too small') });
	});
});
