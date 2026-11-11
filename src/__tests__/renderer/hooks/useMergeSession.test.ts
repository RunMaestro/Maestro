import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import {
	useMergeSession,
	useMergeSessionWithSessions,
	type MergeSessionRequest,
	__resetMergeInProgress,
} from '../../../renderer/hooks';
import type { Session, AITab, LogEntry, ToolType } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import type { MergeOptions } from '../../../renderer/components/MergeSessionModal';
import * as contextGroomer from '../../../renderer/services/contextGroomer';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { SetStateAction } from 'react';
import type { MergeRequest } from '../../../renderer/types/contextMerge';

// Mock the context grooming service
vi.mock('../../../renderer/services/contextGroomer', async () => {
	const actual = await vi.importActual('../../../renderer/services/contextGroomer');
	return {
		...actual,
		contextGroomingService: {
			groomContexts: vi.fn(),
			cancelGrooming: vi.fn(),
			isGroomingActive: vi.fn(() => false),
		},
	};
});

// Mock extractTabContext; the injection formatter stays real so the merge-into-tab
// cases below exercise what actually reaches the target agent.
vi.mock('../../../renderer/utils/contextExtractor', async () => ({
	...(await vi.importActual<typeof import('../../../renderer/utils/contextExtractor')>(
		'../../../renderer/utils/contextExtractor'
	)),
	extractTabContext: vi.fn((tab, name, session) => ({
		type: 'tab',
		sessionId: session.id,
		tabId: tab.id,
		projectRoot: session.projectRoot,
		name: `${name} / ${tab.name || 'Tab'}`,
		logs: tab.logs,
		agentType: tab.pendingTranslation ?? tab.tabProvider ?? session.toolType,
	})),
}));

// Mock createMergedSession
vi.mock('../../../renderer/utils/tabHelpers', () => ({
	createMergedSession: vi.fn(({ name, projectRoot, toolType, mergedLogs }) => ({
		session: {
			id: 'new-merged-session-id',
			name,
			projectRoot,
			toolType,
			state: 'idle',
			cwd: projectRoot,
			fullPath: projectRoot,
			aiTabs: [
				{
					id: 'merged-tab-id',
					name: null,
					logs: mergedLogs,
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
					state: 'idle',
				},
			],
			activeTabId: 'merged-tab-id',
			shellLogs: [],
			workLog: [],
			contextUsage: 0,
			inputMode: 'ai',
			isGitRepo: false,
			aiLogs: [],
			aiPid: 0,
			terminalPid: 0,
			port: 0,
			isLive: false,
			changedFiles: [],
			fileTree: [],
			fileExplorerExpanded: [],
			fileExplorerScrollPos: 0,
			activeTimeMs: 0,
			executionQueue: [],
			closedTabHistory: [],
		},
		tabId: 'merged-tab-id',
	})),
	getActiveTab: vi.fn((session) => session.aiTabs?.[0] || null),
}));

// Create a mock tab with logs (positional signature thin wrapper over shared factory)
function createMockTab(id: string, logs: LogEntry[] = [], name?: string): AITab {
	return createMockAITab({
		id,
		name: name || `Tab ${id}`,
		agentSessionId: `session-${id}`,
		logs,
		saveToHistory: true,
	});
}

// Thin wrapper: positional signature is preserved for test readability.
// Pre-populates a tab with hello/hi logs so merge tests have content.
function createMockSession(
	id: string,
	toolType: ToolType = 'claude-code',
	state: 'idle' | 'busy' | 'error' | 'connecting' = 'idle',
	tabs?: AITab[]
): Session {
	const defaultTab = createMockTab('tab-1', [
		{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'Hello from source' },
		{ id: 'log-2', timestamp: Date.now() + 100, source: 'ai', text: 'Hi! How can I help you?' },
	]);
	const resolvedTabs = tabs || [defaultTab];
	return baseCreateMockSession({
		id,
		name: `Session ${id}`,
		toolType,
		state,
		aiTabs: resolvedTabs,
		activeTabId: resolvedTabs[0].id,
	});
}

describe('useMergeSession', () => {
	it.each([false, true])(
		'grooms for the destination provider (new agent: %s)',
		async (createNewSession) => {
			const sourceSession = createMockSession('source', 'claude-code');
			sourceSession.aiTabs[0].tabProvider = 'opencode';
			const targetSession = createMockSession('target', 'opencode');
			targetSession.aiTabs[0].tabProvider = 'codex';
			const { result } = renderHook(() => useMergeSession());
			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: true, createNewSession, preserveTimestamps: true },
				});
			});
			expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalledWith(
				expect.objectContaining({ targetAgent: createNewSession ? 'claude-code' : 'codex' }),
				expect.any(Function)
			);
			if (createNewSession) {
				const { createMergedSession } = await import('../../../renderer/utils/tabHelpers');
				expect(createMergedSession).toHaveBeenCalledWith(
					expect.objectContaining({ toolType: 'claude-code' })
				);
			}
		}
	);

	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock for successful grooming
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
			groomedLogs: [
				{
					id: 'groomed-1',
					timestamp: Date.now(),
					source: 'ai',
					text: 'Consolidated context summary',
				},
			],
			tokensSaved: 100,
			success: true,
		});
	});

	afterEach(() => {
		cleanup();
		// Reset global merge flag between tests
		__resetMergeInProgress?.();
	});

	describe('initial state', () => {
		it('starts in idle state', () => {
			const { result } = renderHook(() => useMergeSession());

			expect(result.current.mergeState).toBe('idle');
			expect(result.current.progress).toBeNull();
			expect(result.current.error).toBeNull();
		});

		it('provides startMerge, cancelMerge, and reset functions', () => {
			const { result } = renderHook(() => useMergeSession());

			expect(typeof result.current.startMerge).toBe('function');
			expect(typeof result.current.cancelMerge).toBe('function');
			expect(typeof result.current.reset).toBe('function');
		});
	});

	describe('merging two tabs from same session', () => {
		it('successfully merges two tabs from the same session', async () => {
			// Pass activeTabId to track per-tab state
			const { result } = renderHook(() => useMergeSession('tab-1'));

			// Create a session with two tabs
			const tab1 = createMockTab('tab-1', [
				{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'First conversation' },
			]);
			const tab2 = createMockTab('tab-2', [
				{ id: 'log-2', timestamp: Date.now() + 1000, source: 'user', text: 'Second conversation' },
			]);
			const session = createMockSession('session-1', 'claude-code', 'idle', [tab1, tab2]);

			const request: MergeSessionRequest = {
				sourceSession: session,
				sourceTabId: 'tab-1',
				targetSession: session,
				targetTabId: 'tab-2',
				options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
			};

			let mergeResult;
			await act(async () => {
				mergeResult = await result.current.startMerge(request);
			});

			expect(mergeResult.success).toBe(true);
			expect(mergeResult.newSessionId).toBeDefined();
			expect(result.current.mergeState).toBe('complete');
		});

		it('generates correct name for same-session merge', async () => {
			const { result } = renderHook(() => useMergeSession());

			const tab1 = createMockTab('tab-1', [
				{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'Hello' },
			]);
			const tab2 = createMockTab('tab-2', [
				{ id: 'log-2', timestamp: Date.now(), source: 'ai', text: 'Hi' },
			]);
			const session = createMockSession('session-1', 'claude-code', 'idle', [tab1, tab2]);
			session.name = 'My Project';

			await act(async () => {
				await result.current.startMerge({
					sourceSession: session,
					sourceTabId: 'tab-1',
					targetSession: session,
					targetTabId: 'tab-2',
					options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
				});
			});

			const { createMergedSession } = await import('../../../renderer/utils/tabHelpers');
			expect(createMergedSession).toHaveBeenCalledWith(
				expect.objectContaining({
					name: expect.stringContaining('Merged'),
				})
			);
		});
	});

	describe('merging tabs from different sessions', () => {
		it('successfully merges tabs from different sessions', async () => {
			// Pass activeTabId to track per-tab state
			const { result } = renderHook(() => useMergeSession('tab-1'));

			const sourceSession = createMockSession('source-1', 'claude-code');
			sourceSession.name = 'Source Project';

			const targetSession = createMockSession('target-1', 'claude-code');
			targetSession.name = 'Target Project';

			const request: MergeSessionRequest = {
				sourceSession,
				sourceTabId: 'tab-1',
				targetSession,
				targetTabId: 'tab-1',
				options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
			};

			let mergeResult;
			await act(async () => {
				mergeResult = await result.current.startMerge(request);
			});

			expect(mergeResult.success).toBe(true);
			expect(result.current.mergeState).toBe('complete');
		});

		it('generates combined name for cross-session merge', async () => {
			const { result } = renderHook(() => useMergeSession());

			const sourceSession = createMockSession('source-1');
			sourceSession.name = 'Project A';
			const targetSession = createMockSession('target-1');
			targetSession.name = 'Project B';

			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
				});
			});

			const { createMergedSession } = await import('../../../renderer/utils/tabHelpers');
			expect(createMergedSession).toHaveBeenCalledWith(
				expect.objectContaining({
					name: expect.stringMatching(/Merged.*Project A.*Project B|Merged.*Project B.*Project A/),
				})
			);
		});
	});

	describe('merging very large contexts (10k+ tokens)', () => {
		it('completes merge successfully for large contexts', async () => {
			// Note: The actual warning check happens at the implementation level
			// with estimateTokensFromLogs which uses tab.logs directly
			// Since our mock abstracts this, we just verify the merge completes

			// Pass activeTabId to track per-tab state
			const { result } = renderHook(() => useMergeSession('tab-1'));

			// Create tabs with significant content
			const sourceTab = createMockTab('tab-1', [
				{ id: 'log-1', timestamp: Date.now(), source: 'user', text: 'A'.repeat(5000) },
				{ id: 'log-2', timestamp: Date.now() + 100, source: 'ai', text: 'B'.repeat(5000) },
			]);
			const targetTab = createMockTab('tab-2', [
				{ id: 'log-3', timestamp: Date.now() + 200, source: 'user', text: 'C'.repeat(5000) },
			]);

			const sourceSession = createMockSession('source', 'claude-code', 'idle', [sourceTab]);
			const targetSession = createMockSession('target', 'claude-code', 'idle', [targetTab]);

			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-2',
					options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
				});
			});

			// Large context merges should still complete successfully
			expect(result.current.mergeState).toBe('complete');
		});
	});

	describe('edge cases', () => {
		describe('self-merge attempt', () => {
			it('rejects merging a tab with itself', async () => {
				// Pass activeTabId to track per-tab state
				const { result } = renderHook(() => useMergeSession('tab-1'));

				const session = createMockSession('session-1');

				let mergeResult;
				await act(async () => {
					mergeResult = await result.current.startMerge({
						sourceSession: session,
						sourceTabId: 'tab-1',
						targetSession: session,
						targetTabId: 'tab-1', // Same as source
						options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
					});
				});

				expect(mergeResult.success).toBe(false);
				expect(mergeResult.error).toBe('Cannot merge a tab with itself');
				expect(result.current.mergeState).toBe('error');
			});
		});

		describe('empty context source', () => {
			it('rejects merging when source tab has no logs', async () => {
				// Pass activeTabId to track per-tab state
				const { result } = renderHook(() => useMergeSession('empty-tab'));

				const emptyTab = createMockTab('empty-tab', []); // No logs
				const sourceSession = createMockSession('source', 'claude-code', 'idle', [emptyTab]);
				const targetSession = createMockSession('target');

				let mergeResult;
				await act(async () => {
					mergeResult = await result.current.startMerge({
						sourceSession,
						sourceTabId: 'empty-tab',
						targetSession,
						targetTabId: 'tab-1',
						options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
					});
				});

				expect(mergeResult.success).toBe(false);
				expect(mergeResult.error).toContain('Cannot merge empty context');
				expect(result.current.mergeState).toBe('error');
			});

			it('allows merging into empty target tab (copies source context)', async () => {
				const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

				const { result } = renderHook(() => useMergeSession());

				const emptyTab = createMockTab('empty-tab', []);
				const sourceSession = createMockSession('source');
				const targetSession = createMockSession('target', 'claude-code', 'idle', [emptyTab]);

				let mergeResult;
				await act(async () => {
					mergeResult = await result.current.startMerge({
						sourceSession,
						sourceTabId: 'tab-1',
						targetSession,
						targetTabId: 'empty-tab',
						options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
					});
				});

				expect(mergeResult.success).toBe(true);
				expect(consoleSpy).toHaveBeenCalledWith(
					expect.stringContaining('Merging into empty target tab')
				);

				consoleSpy.mockRestore();
			});
		});

		describe('source/target tab not found', () => {
			it('returns error when source tab is not found', async () => {
				const { result } = renderHook(() => useMergeSession());

				const session = createMockSession('session-1');

				let mergeResult;
				await act(async () => {
					mergeResult = await result.current.startMerge({
						sourceSession: session,
						sourceTabId: 'non-existent-tab',
						targetSession: session,
						targetTabId: 'tab-1',
						options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
					});
				});

				expect(mergeResult.success).toBe(false);
				expect(mergeResult.error).toBe('Source tab not found');
			});

			it('returns error when target tab is not found', async () => {
				const { result } = renderHook(() => useMergeSession());

				const sourceSession = createMockSession('source');
				const targetSession = createMockSession('target');

				let mergeResult;
				await act(async () => {
					mergeResult = await result.current.startMerge({
						sourceSession,
						sourceTabId: 'tab-1',
						targetSession,
						targetTabId: 'non-existent-tab',
						options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
					});
				});

				expect(mergeResult.success).toBe(false);
				expect(mergeResult.error).toBe('Target tab not found');
			});
		});

		describe('concurrent merge operations', () => {
			it('rejects concurrent merge requests', async () => {
				// Create a slow grooming operation
				vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
					() =>
						new Promise((resolve) =>
							setTimeout(
								() =>
									resolve({
										groomedLogs: [{ id: 'log', timestamp: Date.now(), source: 'ai', text: 'Done' }],
										tokensSaved: 10,
										success: true,
									}),
								200
							)
						)
				);

				const { result } = renderHook(() => useMergeSession());

				const sourceSession = createMockSession('source');
				const targetSession = createMockSession('target');

				// Start first merge without awaiting
				const firstMerge = result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
				});

				// Try to start second merge immediately
				let secondResult;
				await act(async () => {
					secondResult = await result.current.startMerge({
						sourceSession,
						sourceTabId: 'tab-1',
						targetSession,
						targetTabId: 'tab-1',
						options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
					});
				});

				expect(secondResult.success).toBe(false);
				expect(secondResult.error).toContain('already in progress');

				// Wait for first merge to complete to clean up
				await act(async () => {
					await firstMerge;
				});
			});
		});
	});

	describe('grooming context', () => {
		it('uses AI grooming when groomContext is true', async () => {
			const { result } = renderHook(() => useMergeSession());

			const sourceSession = createMockSession('source');
			const targetSession = createMockSession('target');

			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
				});
			});

			expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalled();
		});

		it('skips grooming when groomContext is false', async () => {
			const { result } = renderHook(() => useMergeSession());

			const sourceSession = createMockSession('source');
			const targetSession = createMockSession('target');

			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
				});
			});

			expect(contextGroomer.contextGroomingService.groomContexts).not.toHaveBeenCalled();
		});

		it('handles grooming failure gracefully', async () => {
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
				groomedLogs: [],
				tokensSaved: 0,
				success: false,
				error: 'Grooming timeout',
			});

			// Pass activeTabId to track per-tab state
			const { result } = renderHook(() => useMergeSession('tab-1'));

			const sourceSession = createMockSession('source');
			const targetSession = createMockSession('target');

			let mergeResult;
			await act(async () => {
				mergeResult = await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
				});
			});

			expect(mergeResult.success).toBe(false);
			expect(mergeResult.error).toBe('Grooming timeout');
			expect(result.current.mergeState).toBe('error');
		});
	});

	describe('cancelMerge', () => {
		it('cancels an active merge operation', async () => {
			// Set up slow grooming
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({
									groomedLogs: [],
									tokensSaved: 0,
									success: true,
								}),
							1000
						)
					)
			);

			// Pass activeTabId to track per-tab state
			const { result } = renderHook(() => useMergeSession('tab-1'));

			const sourceSession = createMockSession('source');
			const targetSession = createMockSession('target');

			// Start merge without awaiting
			const mergePromise = result.current.startMerge({
				sourceSession,
				sourceTabId: 'tab-1',
				targetSession,
				targetTabId: 'tab-1',
				options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
			});

			// Cancel immediately - clears all state back to idle
			act(() => {
				result.current.cancelMerge();
			});

			// Cancellation clears state entirely (no error shown - just returns to idle)
			expect(result.current.mergeState).toBe('idle');
			expect(result.current.error).toBeNull();
			expect(contextGroomer.contextGroomingService.cancelGrooming).toHaveBeenCalled();
		});
	});

	describe('reset', () => {
		it('resets state to idle', async () => {
			const { result } = renderHook(() => useMergeSession());

			const sourceSession = createMockSession('source');
			const targetSession = createMockSession('target');

			// First do a merge
			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
				});
			});

			// Reset
			act(() => {
				result.current.reset();
			});

			// Verify reset happened
			expect(result.current.mergeState).toBe('idle');
			expect(result.current.progress).toBeNull();
			expect(result.current.error).toBeNull();
		});
	});

	describe('progress updates', () => {
		it('calls grooming service with progress callback when grooming enabled', async () => {
			const { result } = renderHook(() => useMergeSession());

			const sourceSession = createMockSession('source');
			const targetSession = createMockSession('target');

			await act(async () => {
				await result.current.startMerge({
					sourceSession,
					sourceTabId: 'tab-1',
					targetSession,
					targetTabId: 'tab-1',
					options: { groomContext: true, createNewSession: true, preserveTimestamps: true },
				});
			});

			// Verify grooming service was called with a progress callback
			expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalledWith(
				expect.any(Object),
				expect.any(Function)
			);
		});
	});

	describe('preserveTimestamps option', () => {
		it('passes preserveTimestamps option to merge operation', async () => {
			const { result } = renderHook(() => useMergeSession());

			// Create tabs with specific timestamps
			const olderLog = { id: 'old', timestamp: 1000, source: 'user' as const, text: 'First' };
			const newerLog = { id: 'new', timestamp: 2000, source: 'ai' as const, text: 'Second' };

			const sourceTab = createMockTab('source-tab', [newerLog]); // Newer log
			const targetTab = createMockTab('target-tab', [olderLog]); // Older log

			const sourceSession = createMockSession('source', 'claude-code', 'idle', [sourceTab]);
			const targetSession = createMockSession('target', 'claude-code', 'idle', [targetTab]);

			let mergeResult;
			await act(async () => {
				mergeResult = await result.current.startMerge({
					sourceSession,
					sourceTabId: 'source-tab',
					targetSession,
					targetTabId: 'target-tab',
					options: { groomContext: false, createNewSession: true, preserveTimestamps: true },
				});
			});

			// Merge should succeed with preserveTimestamps option
			expect(mergeResult.success).toBe(true);
			// Note: Full timestamp sorting behavior is tested in integration tests
			// The hook correctly passes the option to the merge logic
		});
	});
});

// useMergeSessionWithSessions is where merged context reaches another agent:
// the merge-into-tab injection and the new merged agent. These cases cover it
// for Grok sources with the REAL injection formatter (only extractTabContext
// is mocked above), so content loss, duplicate context, account confusion and
// window overflow are visible here rather than only in the formatter's suite.
describe('useMergeSessionWithSessions: Grok carry-over', () => {
	let sessions: Session[];
	const setSessions = vi.fn((update: SetStateAction<Session[]>) => {
		sessions = typeof update === 'function' ? update(sessions) : update;
	});

	function grokSource(logs: LogEntry[]): Session {
		const tab = createMockTab('grok-tab', logs, 'Grok work');
		return {
			...createMockSession('grok-source', 'grok', 'idle', [tab]),
			name: 'Grok Source',
			cwd: '/work/source',
			projectRoot: '/work/source',
			customEnvVars: { GROK_HOME: '/accounts/source-home' },
			customModel: 'grok-source-model',
			sshRemoteId: 'remote-source',
		};
	}

	function target(
		toolType: ToolType,
		tab: Partial<AITab> = {},
		session: Partial<Session> = {}
	): Session {
		const targetTab = {
			...createMockTab('target-tab', [
				{ id: 't-1', timestamp: 1, source: 'user', text: 'TARGET_OWN_HISTORY' },
			]),
			...tab,
		};
		return {
			...createMockSession('target', toolType, 'idle', [targetTab]),
			name: 'Target',
			cwd: '/work/target',
			projectRoot: '/work/target',
			...session,
		};
	}

	function render() {
		return renderHook(() => useMergeSessionWithSessions({ setSessions, activeTabId: 'grok-tab' }));
	}

	function injectedTab(): AITab {
		return sessions.find((s) => s.id === 'target')!.aiTabs.find((t) => t.id === 'target-tab')!;
	}

	const intoTab: MergeOptions = {
		groomContext: false,
		createNewSession: false,
		preserveTimestamps: false,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		sessions = [];
	});

	afterEach(() => {
		cleanup();
		__resetMergeInProgress?.();
		useSessionStore.setState({ sessions: [] });
	});

	function seed(...all: Session[]) {
		sessions = all;
		useSessionStore.setState({ sessions: all });
	}

	it('injects only the ordered Grok source, labelled by provider and cwd, without account identity', async () => {
		const source = grokSource([
			{ id: 's-1', timestamp: Number.NaN, source: 'user', text: 'SOURCE_QUESTION' },
			{ id: 's-2', timestamp: Number.NaN, source: 'system', text: 'MAESTRO_NOTICE resumed' },
			{ id: 's-3', timestamp: Number.NaN, source: 'thinking', text: 'HIDDEN_REASONING' },
			{
				id: 's-4',
				timestamp: Number.NaN,
				source: 'tool',
				text: 'read_file a.ts',
				metadata: { toolState: { status: 'completed', output: 'TOOL_EVIDENCE' } },
			},
			{ id: 's-5', timestamp: Number.NaN, source: 'ai', text: 'SOURCE_ANSWER' },
		]);
		seed(source, target('claude-code'));
		const { result } = render();
		let merge;
		await act(async () => {
			merge = await result.current.executeMerge(
				source,
				'grok-tab',
				'target',
				'target-tab',
				intoTab
			);
		});
		expect(merge).toMatchObject({ success: true });
		const pending = injectedTab().pendingMergedContext!;
		expect(pending.split('\n\n')[0]).toBe(
			'Additional context from another agent (Grok Source; Grok CLI; working directory /work/source):'
		);
		// Order and roles survive; tools stay tool evidence.
		const order = [
			'User: SOURCE_QUESTION',
			'Tool call, completed',
			'Result: TOOL_EVIDENCE',
			'Assistant: SOURCE_ANSWER',
		];
		const positions = order.map((needle) => pending.indexOf(needle));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		// No duplicate context: the target's own history is not pasted back into it.
		expect(pending).not.toContain('TARGET_OWN_HISTORY');
		expect(pending.split('SOURCE_QUESTION')).toHaveLength(2);
		// Notices and hidden reasoning stay out; so does the source account.
		for (const leaked of [
			'MAESTRO_NOTICE',
			'HIDDEN_REASONING',
			'/accounts/source-home',
			'GROK_HOME',
			'remote-source',
		])
			expect(pending).not.toContain(leaked);
		// The target keeps its own history and gets one visible merge note.
		expect(injectedTab().logs.map((log) => log.text)).toEqual([
			'TARGET_OWN_HISTORY',
			'Context merged from "Grok Source".',
		]);
	});

	describe('bounds the injection by the target model window', () => {
		// ~150k tokens of Grok history (600 entries of 1,000 characters).
		const longHistory = Array.from({ length: 600 }, (_, i) => ({
			id: `long-${i}`,
			timestamp: Number.NaN,
			source: (i % 2 ? 'ai' : 'user') as LogEntry['source'],
			text: `entry-${String(i).padStart(3, '0')} ${'h'.repeat(990)}`,
		}));

		it.each([
			{
				label: 'Claude with a provider-reported 200k window',
				target: () =>
					target('claude-code', {
						usageStats: {
							contextWindow: 200_000,
							contextWindowResolved: true,
						} as AITab['usageStats'],
					}),
				budget: 100_000,
				disclosure: "Earlier entries were left out to fit this agent's context window.",
			},
			{
				label: 'Grok with a user-edited 16k window',
				target: () =>
					target('grok', {}, { customContextWindow: 16_000, contextWindowSource: 'user-edited' }),
				budget: 8_000,
				disclosure: "Earlier entries were left out to fit this agent's context window.",
			},
			{
				label: 'Grok with no known window',
				target: () => target('grok'),
				budget: 100_000,
				disclosure:
					"Earlier entries were left out to fit a conservative bound; this agent's context window is unknown.",
			},
		])('$label', async ({ target: makeTarget, budget, disclosure }) => {
			const source = grokSource(longHistory);
			seed(source, makeTarget());
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', intoTab);
			});
			const pending = injectedTab().pendingMergedContext!;
			expect(pending).toContain(disclosure);
			// Within the budget plus the fixed header, never the whole 150k history.
			expect(Math.ceil(pending.length / 4)).toBeLessThanOrEqual(budget + 200);
			// The newest entry always survives; the oldest is the one dropped.
			expect(pending).toContain('entry-599');
			expect(pending).not.toContain('entry-000 ');
		});
	});

	it('gives a new merged agent the source account, host and model, not the target', async () => {
		const source = grokSource([{ id: 's-1', timestamp: 10, source: 'user', text: 'From Grok' }]);
		seed(
			source,
			target(
				'grok',
				{},
				{ customEnvVars: { GROK_HOME: '/accounts/target-home' }, sshRemoteId: 'remote-target' }
			)
		);
		const { result } = render();
		await act(async () => {
			await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
				groomContext: false,
				createNewSession: true,
				preserveTimestamps: false,
			});
		});
		const created = sessions.find((s) => s.id === 'new-merged-session-id')!;
		expect(created).toMatchObject({
			toolType: 'grok',
			cwd: '/work/source',
			customEnvVars: { GROK_HOME: '/accounts/source-home' },
			customModel: 'grok-source-model',
			sshRemoteId: 'remote-source',
		});
		expect(JSON.stringify(created)).not.toContain('/accounts/target-home');
		expect(JSON.stringify(created)).not.toContain('remote-target');
	});

	it.each([
		{
			timestamps: 'unknown (NaN) on the Grok side',
			sourceTs: Number.NaN,
			expected: ['g-1', 'g-2', 't-1'],
		},
		{ timestamps: 'all known', sourceTs: 2, expected: ['t-1', 'g-1', 'g-2'] },
	])(
		'orders merged logs safely when timestamps are $timestamps',
		async ({ sourceTs, expected }) => {
			const source = grokSource([
				{ id: 'g-1', timestamp: sourceTs, source: 'user', text: 'grok first' },
				{ id: 'g-2', timestamp: sourceTs, source: 'ai', text: 'grok second' },
			]);
			seed(source, target('claude-code'));
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					groomContext: false,
					createNewSession: true,
					preserveTimestamps: true,
				});
			});
			const created = sessions.find((s) => s.id === 'new-merged-session-id')!;
			expect(created.aiTabs[0].logs.map((log) => log.id)).toEqual(expected);
		}
	);

	it('cancels a Grok merge during grooming without touching either agent', async () => {
		let finishGrooming!: (
			value: Awaited<ReturnType<typeof contextGroomer.contextGroomingService.groomContexts>>
		) => void;
		vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockImplementation(
			() => new Promise((resolve) => (finishGrooming = resolve))
		);
		const source = grokSource([{ id: 's-1', timestamp: 1, source: 'user', text: 'cancel me' }]);
		seed(source, target('claude-code'));
		const before = sessions;
		const { result } = render();
		let pending!: Promise<unknown>;
		act(() => {
			pending = result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
				...intoTab,
				groomContext: true,
			});
		});
		await waitFor(() =>
			expect(contextGroomer.contextGroomingService.groomContexts).toHaveBeenCalledTimes(1)
		);
		act(() => result.current.cancelMerge());
		expect(contextGroomer.contextGroomingService.cancelGrooming).toHaveBeenCalled();
		// A late grooming answer after the cancel must not be applied.
		finishGrooming({
			groomedLogs: [{ id: 'late', timestamp: 2, source: 'ai', text: 'LATE_GROOMED' }],
			tokensSaved: 1,
			success: true,
		});
		await act(async () => {
			expect(await pending).toEqual({ success: false, error: 'Merge cancelled' });
		});
		expect(setSessions).not.toHaveBeenCalled();
		expect(sessions).toBe(before);
	});

	// The groomed output is
	// what a merge carries, and only groomed context is called cleaned.
	describe('grooming results', () => {
		const groomed = [
			{ id: 'groomed-1', timestamp: 5, source: 'ai' as const, text: 'GROOMED_SUMMARY' },
		];

		beforeEach(() => {
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
				groomedLogs: groomed,
				tokensSaved: 10,
				success: true,
			});
		});

		it('a groomed new merged agent carries the groomed logs, not both raw sides', async () => {
			const source = grokSource([{ id: 's-1', timestamp: 1, source: 'user', text: 'RAW_SOURCE' }]);
			seed(source, target('claude-code'));
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					groomContext: true,
					createNewSession: true,
					preserveTimestamps: false,
				});
			});
			const created = sessions.find((s) => s.id === 'new-merged-session-id')!;
			expect(created.aiTabs[0].logs.map((log) => log.text)).toEqual(['GROOMED_SUMMARY']);
		});

		it('a merge into a tab never labels raw injected context as cleaned', async () => {
			const source = grokSource([{ id: 's-1', timestamp: 1, source: 'user', text: 'RAW_SOURCE' }]);
			seed(source, target('claude-code'));
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					...intoTab,
					groomContext: true,
				});
			});
			const tab = injectedTab();
			const claimsCleaned = tab.logs.some((log) => log.text.includes('cleaned to reduce size'));
			const injectedRaw = tab.pendingMergedContext?.includes('RAW_SOURCE') ?? false;
			expect(claimsCleaned && injectedRaw).toBe(false);
		});

		// The grooming turn is the source agent's own turn (its
		// account, binary and host), and a merge into a tab grooms the source
		// alone so the target's history is never pasted back.
		function groomedSource(): Session {
			return {
				...grokSource([{ id: 's-1', timestamp: 1, source: 'user', text: 'RAW_SOURCE' }]),
				customPath: '/bin/grok-source',
				customArgs: '--source-arg',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-source',
					workingDirOverride: '/remote/source',
				},
			};
		}

		function otherAccountTarget(): Session {
			return target(
				'grok',
				{},
				{
					customEnvVars: { GROK_HOME: '/accounts/target-home' },
					customPath: '/bin/grok-target',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-target' },
				}
			);
		}

		function groomingRequest(): MergeRequest {
			const groom = vi.mocked(contextGroomer.contextGroomingService.groomContexts);
			expect(groom).toHaveBeenCalledTimes(1);
			return groom.mock.calls[0][0];
		}

		it('grooms on the source agent identity, never the target account or host', async () => {
			const source = groomedSource();
			seed(source, otherAccountTarget());
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					groomContext: true,
					createNewSession: true,
					preserveTimestamps: false,
				});
			});
			const request = groomingRequest();
			expect(request.targetAgent).toBe('grok');
			expect(request.targetProjectRoot).toBe('/work/source');
			expect(request.customEnvVars).toEqual({ GROK_HOME: '/accounts/source-home' });
			expect(request.customPath).toBe('/bin/grok-source');
			expect(request.customArgs).toBe('--source-arg');
			expect(request.sshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-source',
				workingDirOverride: '/remote/source',
			});
			expect(JSON.stringify(request)).not.toContain('target-home');
			expect(JSON.stringify(request)).not.toContain('remote-target');
		});

		it('a merge into a tab grooms the source alone and injects only the groomed result as cleaned', async () => {
			const source = groomedSource();
			seed(source, otherAccountTarget());
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					...intoTab,
					groomContext: true,
				});
			});
			const request = groomingRequest();
			expect(request.sources.map((s) => s.sessionId)).toEqual(['grok-source']);
			expect(JSON.stringify(request.sources)).not.toContain('TARGET_OWN_HISTORY');
			expect(request.customEnvVars).toEqual({ GROK_HOME: '/accounts/source-home' });

			const tab = injectedTab();
			expect(tab.pendingMergedContext).toContain('GROOMED_SUMMARY');
			expect(tab.pendingMergedContext).not.toContain('RAW_SOURCE');
			expect(tab.pendingMergedContext).not.toContain('TARGET_OWN_HISTORY');
			expect(tab.logs.some((log) => log.text.includes('cleaned to reduce size'))).toBe(true);
		});

		it('a new merged agent grooms both sides once, source first', async () => {
			const source = groomedSource();
			seed(source, otherAccountTarget());
			const { result } = render();
			await act(async () => {
				await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					groomContext: true,
					createNewSession: true,
					preserveTimestamps: false,
				});
			});
			expect(groomingRequest().sources.map((s) => s.sessionId)).toEqual(['grok-source', 'target']);
		});

		it('a refused grooming turn fails the merge instead of falling back to raw context', async () => {
			vi.mocked(contextGroomer.contextGroomingService.groomContexts).mockResolvedValue({
				groomedLogs: [],
				tokensSaved: 0,
				success: false,
				error: 'grok cannot enforce read-only for this route',
			});
			const source = groomedSource();
			seed(source, otherAccountTarget());
			const { result } = render();
			let merge: Awaited<ReturnType<typeof result.current.executeMerge>> | undefined;
			await act(async () => {
				merge = await result.current.executeMerge(source, 'grok-tab', 'target', 'target-tab', {
					...intoTab,
					groomContext: true,
				});
			});
			expect(merge?.success).toBe(false);
			const tab = injectedTab();
			expect(tab.pendingMergedContext ?? '').not.toContain('RAW_SOURCE');
			expect(sessions.some((s) => s.id === 'new-merged-session-id')).toBe(false);
		});
	});
});
