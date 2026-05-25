/**
 * @file useMergeSession.test.tsx
 * @description Tests for merge-session orchestration hooks.
 */

import { act, renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AITab, LogEntry, Session } from '../../../../renderer/types';
import type { MergeOptions } from '../../../../renderer/components/MergeSessionModal';
import {
	__resetMergeInProgress,
	useMergeSession,
	useMergeSessionWithSessions,
} from '../../../../renderer/hooks/agent/useMergeSession';
import { useOperationStore } from '../../../../renderer/stores/operationStore';

const groomingMocks = vi.hoisted(() => ({
	groomContexts: vi.fn(),
	cancelGrooming: vi.fn(),
}));

vi.mock('../../../../renderer/services/contextGroomer', () => ({
	ContextGroomingService: vi.fn(),
	contextGroomingService: {
		groomContexts: groomingMocks.groomContexts,
		cancelGrooming: groomingMocks.cancelGrooming,
	},
}));

afterEach(() => {
	act(() => {
		useOperationStore.getState().resetAll();
	});
	vi.restoreAllMocks();
});

const rawMergeOptions: MergeOptions = {
	createNewSession: false,
	groomContext: false,
	preserveTimestamps: true,
};

const newSessionOptions: MergeOptions = {
	...rawMergeOptions,
	createNewSession: true,
};

const makeLog = (
	id: string,
	text: string,
	timestamp: number,
	source: LogEntry['source'] = 'user'
): LogEntry => ({
	id,
	text,
	timestamp,
	source,
});

const makeTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: 'tab-1',
	agentSessionId: 'agent-session-1',
	name: 'Tab One',
	starred: false,
	logs: [makeLog('log-1', 'hello from tab one', 20)],
	inputValue: '',
	stagedImages: [],
	createdAt: 1,
	state: 'idle',
	...overrides,
});

const makeSession = (overrides: Partial<Session> = {}): Session => {
	const aiTabs = overrides.aiTabs ?? [makeTab()];
	const activeTabId = overrides.activeTabId ?? aiTabs[0]?.id ?? 'tab-1';

	const baseSession = {
		id: 'session-1',
		name: 'Session One',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/one',
		fullPath: '/repo/one',
		projectRoot: '/repo/one',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3001,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
	};

	return {
		...baseSession,
		...overrides,
		aiTabs,
		activeTabId,
	};
};

const makeRequest = (
	overrides: Partial<Parameters<ReturnType<typeof useMergeSession>['startMerge']>[0]> = {}
) => {
	const sourceSession = makeSession({
		id: 'source-session',
		name: 'Source Session',
		projectRoot: '/repo/source',
		aiTabs: [
			makeTab({
				id: 'source-tab',
				name: 'Source Tab',
				logs: [makeLog('source-log', 'source context', 20, 'user')],
			}),
		],
		activeTabId: 'source-tab',
	});
	const targetSession = makeSession({
		id: 'target-session',
		name: 'Target Session',
		projectRoot: '/repo/target',
		aiTabs: [
			makeTab({
				id: 'target-tab',
				name: 'Target Tab',
				logs: [makeLog('target-log', 'target context', 10, 'ai')],
			}),
		],
		activeTabId: 'target-tab',
	});

	return {
		sourceSession,
		sourceTabId: 'source-tab',
		targetSession,
		targetTabId: 'target-tab',
		options: rawMergeOptions,
		...overrides,
	};
};

describe('useMergeSession', () => {
	beforeEach(() => {
		useOperationStore.getState().resetAll();
		groomingMocks.groomContexts.mockReset();
		groomingMocks.cancelGrooming.mockReset();
		(window as any).maestro = {
			history: {
				add: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	it('exposes active-tab state and clears merge state through reset and cancel actions', () => {
		const store = useOperationStore.getState();
		store.setMergeTabState('source-tab', {
			state: 'merging',
			progress: { stage: 'collecting', progress: 10, message: 'Collecting' },
			result: null,
			error: null,
			startTime: 123,
			sourceName: 'Source Session',
			targetName: 'Target Session',
		});
		store.setGlobalMergeInProgress(true);

		const { result } = renderHook(() => useMergeSession('source-tab'));

		expect(result.current.mergeState).toBe('merging');
		expect(result.current.progress?.message).toBe('Collecting');
		expect(result.current.isMergeInProgress).toBe(true);
		expect(result.current.isAnyMerging).toBe(true);
		expect(result.current.getTabMergeState('source-tab')?.sourceName).toBe('Source Session');

		act(() => result.current.clearTabState('source-tab'));

		expect(result.current.getTabMergeState('source-tab')).toBeNull();

		act(() => {
			store.setMergeTabState('source-tab', {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 456,
			});
			store.setGlobalMergeInProgress(true);
			result.current.cancelTab('source-tab');
		});

		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(result.current.getTabMergeState('source-tab')).toBeNull();
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);

		act(() => {
			store.setMergeTabState('other-tab', {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 789,
			});
			store.setGlobalMergeInProgress(true);
			result.current.cancelMerge();
		});

		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(2);
		expect(useOperationStore.getState().mergeStates.size).toBe(0);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);

		act(() => {
			store.setMergeTabState('source-tab', {
				state: 'complete',
				progress: null,
				result: null,
				error: null,
				startTime: 1000,
			});
			store.setGlobalMergeInProgress(true);
			result.current.reset();
		});

		expect(useOperationStore.getState().mergeStates.size).toBe(0);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('returns idle defaults when no active tab is selected', () => {
		const { result } = renderHook(() => useMergeSession());

		expect(result.current.mergeState).toBe('idle');
		expect(result.current.progress).toBeNull();
		expect(result.current.error).toBeNull();
		expect(result.current.startTime).toBe(0);
	});

	it('rejects concurrent merge requests before starting work', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));

		act(() => {
			useOperationStore.getState().setGlobalMergeInProgress(true);
		});

		const concurrentResult = await act(async () => result.current.startMerge(makeRequest()));

		expect(concurrentResult).toEqual({
			success: false,
			error: 'A merge operation is already in progress. Please wait for it to complete.',
		});

		act(() => {
			result.current.reset();
			useOperationStore.getState().setMergeTabState('source-tab', {
				state: 'merging',
				progress: null,
				result: null,
				error: null,
				startTime: 1,
			});
		});

		const duplicateTabResult = await act(async () => result.current.startMerge(makeRequest()));

		expect(duplicateTabResult).toEqual({
			success: false,
			error: 'This tab is already being merged.',
		});
	});

	it.each([
		{
			name: 'missing source tab',
			request: () => makeRequest({ sourceTabId: 'missing-source' }),
			error: 'Source tab not found',
		},
		{
			name: 'missing target tab',
			request: () => makeRequest({ targetTabId: 'missing-target' }),
			error: 'Target tab not found',
		},
		{
			name: 'self merge',
			request: () => {
				const session = makeSession({
					id: 'same-session',
					name: 'Same Session',
					aiTabs: [makeTab({ id: 'same-tab', logs: [makeLog('same-log', 'same context', 1)] })],
					activeTabId: 'same-tab',
				});
				return makeRequest({
					sourceSession: session,
					sourceTabId: 'same-tab',
					targetSession: session,
					targetTabId: 'same-tab',
				});
			},
			error: 'Cannot merge a tab with itself',
		},
		{
			name: 'empty source context',
			request: () =>
				makeRequest({
					sourceSession: makeSession({
						id: 'empty-source',
						name: 'Empty Source',
						aiTabs: [makeTab({ id: 'source-tab', logs: [] })],
						activeTabId: 'source-tab',
					}),
				}),
			error: 'Cannot merge empty context - source tab has no conversation history',
		},
	])('records an error state for $name', async ({ request, error }) => {
		const { result } = renderHook(() => useMergeSession('source-tab'));

		const mergeRequest = request();
		const mergeResult = await act(async () => result.current.startMerge(mergeRequest));
		const stateTabId = mergeRequest.sourceTabId;

		expect(mergeResult).toEqual({ success: false, error });
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
		expect(result.current.getTabMergeState(stateTabId)?.state).toBe('error');
		expect(result.current.getTabMergeState(stateTabId)?.error).toBe(error);
	});

	it('creates a raw merged session with sorted logs and completion state', async () => {
		const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const largeText = 'x'.repeat(400_004);
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			projectRoot: '/repo/source',
			groupId: 'group-1',
			aiTabs: [
				makeTab({
					id: 'source-tab',
					logs: [makeLog('source-late', largeText, 30, 'user')],
				}),
			],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: 'Target Session',
			aiTabs: [makeTab({ id: 'target-tab', logs: [] })],
			activeTabId: 'target-tab',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					sourceSession,
					targetSession,
					options: newSessionOptions,
				})
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(mergeResult.newSessionId).toBeTruthy();
		expect(mergeResult.newTabId).toBeTruthy();
		expect(mergeResult.sourceSessionName).toBe('Source Session');
		expect(mergeResult.targetSessionName).toBe('Target Session');
		expect(mergeResult.estimatedTokens).toBeGreaterThan(100_000);
		expect(consoleInfo).toHaveBeenCalledWith(
			'Merging into empty target tab - will copy source context'
		);
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Large context merge'));
		expect(result.current.getTabMergeState('source-tab')?.state).toBe('complete');
		expect(result.current.getTabMergeState('source-tab')?.progress?.progress).toBe(100);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('returns raw merged logs for existing target tabs without timestamp sorting when requested', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					options: {
						...rawMergeOptions,
						preserveTimestamps: false,
					},
				})
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(mergeResult.mergedLogs?.map((log) => log.id)).toEqual(['source-log', 'target-log']);
		expect(mergeResult.targetSessionId).toBe('target-session');
		expect(mergeResult.targetTabId).toBe('target-tab');
	});

	it('uses the target active tab and display-name fallbacks when target tab id is omitted', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const sourceSession = makeSession({
			id: 'source-session',
			name: '',
			projectRoot: '/repo/source-project',
			aiTabs: [
				makeTab({
					id: 'source-tab',
					logs: [
						{
							...makeLog('source-missing-text', '', 20, 'user'),
							text: undefined as unknown as string,
						},
					],
				}),
			],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: '',
			projectRoot: '/repo/target-project',
			aiTabs: [makeTab({ id: 'target-active', logs: [makeLog('target-log', 'target', 10, 'ai')] })],
			activeTabId: 'target-active',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					sourceSession,
					targetSession,
					targetTabId: undefined,
				})
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(mergeResult.targetTabId).toBe('target-active');
		expect(mergeResult.sourceSessionName).toBe('source-project');
		expect(mergeResult.targetSessionName).toBe('target-project');
	});

	it('uses unnamed display fallback when session name and project root are empty', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const sourceSession = makeSession({
			id: 'source-session',
			name: '',
			projectRoot: '',
			aiTabs: [makeTab({ id: 'source-tab', logs: [makeLog('source-log', 'source', 20)] })],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: '',
			projectRoot: '',
			aiTabs: [makeTab({ id: 'target-tab', logs: [makeLog('target-log', 'target', 10, 'ai')] })],
			activeTabId: 'target-tab',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					sourceSession,
					targetSession,
				})
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(mergeResult.sourceSessionName).toBe('Unnamed Session');
		expect(mergeResult.targetSessionName).toBe('Unnamed Session');
	});

	it('returns a target-tab error when no target tab id or active tab exists', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const targetSession = makeSession({
			id: 'target-session',
			aiTabs: [],
			activeTabId: '',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					targetSession,
					targetTabId: undefined,
				})
			)
		);

		expect(mergeResult).toEqual({
			success: false,
			error: 'Target tab not found',
		});
	});

	it('allows merging different tabs from the same session into a new session', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const sourceTab = makeTab({
			id: 'source-tab',
			logs: [makeLog('source-log', 'source context', 20, 'user')],
		});
		const targetTab = makeTab({
			id: 'target-tab',
			logs: [makeLog('target-log', 'target context', 10, 'ai')],
		});
		const sharedSession = makeSession({
			id: 'shared-session',
			name: 'Shared Session',
			aiTabs: [sourceTab, targetTab],
			activeTabId: 'source-tab',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					sourceSession: sharedSession,
					targetSession: sharedSession,
					sourceTabId: 'source-tab',
					targetTabId: 'target-tab',
					options: newSessionOptions,
				})
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(mergeResult.newSessionId).toBeTruthy();
		expect(mergeResult.sourceSessionName).toBe('Shared Session');
		expect(mergeResult.targetSessionName).toBe('Shared Session');
	});

	it('returns a cancellation result when cancelled after context size validation', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {
			result.current.cancelTab('source-tab');
		});
		const largeText = 'x'.repeat(400_004);
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			aiTabs: [
				makeTab({
					id: 'source-tab',
					logs: [makeLog('source-large', largeText, 30, 'user')],
				}),
			],
			activeTabId: 'source-tab',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					sourceSession,
				})
			)
		);

		expect(mergeResult).toEqual({ success: false, error: 'Merge cancelled' });
		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Large context merge'));
		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('returns a cancellation result after target context collection', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		const targetLogs = [makeLog('target-log', 'target context', 10, 'ai')];
		const targetTab = makeTab({ id: 'target-tab' });
		let targetLogAccesses = 0;
		let cancelled = false;
		Object.defineProperty(targetTab, 'logs', {
			configurable: true,
			get: () => {
				targetLogAccesses += 1;
				// The third logs read happens during target context extraction, after validation.
				if (targetLogAccesses >= 3 && !cancelled) {
					cancelled = true;
					result.current.cancelTab('source-tab');
				}
				return targetLogs;
			},
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: 'Target Session',
			aiTabs: [targetTab],
			activeTabId: 'target-tab',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					targetSession,
				})
			)
		);

		expect(mergeResult).toEqual({ success: false, error: 'Merge cancelled' });
		expect(targetLogAccesses).toBeGreaterThanOrEqual(3);
		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('returns a cancellation result after raw log combination', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		let cancelled = false;
		const sourceLog = makeLog('source-sort', 'source context', 20, 'user');
		Object.defineProperty(sourceLog, 'timestamp', {
			configurable: true,
			get: () => {
				// Sorting raw merged logs is the last synchronous point before the final cancel check.
				if (!cancelled) {
					cancelled = true;
					result.current.cancelTab('source-tab');
				}
				return 20;
			},
		});
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			aiTabs: [makeTab({ id: 'source-tab', logs: [sourceLog] })],
			activeTabId: 'source-tab',
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					sourceSession,
				})
			)
		);

		expect(mergeResult).toEqual({ success: false, error: 'Merge cancelled' });
		expect(cancelled).toBe(true);
		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('uses grooming results and progress callbacks when grooming is enabled', async () => {
		const groomedLogs = [makeLog('groomed-log', 'deduped context', 99, 'ai')];
		groomingMocks.groomContexts.mockImplementation(async (_request, onProgress) => {
			onProgress({ stage: 'grooming', progress: 55, message: 'Halfway groomed' });
			return {
				success: true,
				groomedLogs,
				tokensSaved: 42,
			};
		});
		const { result } = renderHook(() => useMergeSession('source-tab'));

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					options: {
						...rawMergeOptions,
						groomContext: true,
					},
				})
			)
		);

		expect(groomingMocks.groomContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: 'claude-code',
				targetProjectRoot: '/repo/source',
			}),
			expect.any(Function)
		);
		expect(mergeResult.success).toBe(true);
		expect(mergeResult.mergedLogs).toEqual(groomedLogs);
		expect(mergeResult.tokensSaved).toBe(42);
		expect(result.current.getTabMergeState('source-tab')?.progress?.message).toBe(
			'Merge complete! Saved ~42 tokens'
		);
	});

	it('returns a cancellation result when grooming is cancelled before completion', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		groomingMocks.groomContexts.mockImplementation(async (_request, onProgress) => {
			result.current.cancelTab('source-tab');
			onProgress({ stage: 'grooming', progress: 99, message: 'Should not publish' });
			return {
				success: true,
				groomedLogs: [makeLog('cancelled-log', 'cancelled context', 1)],
				tokensSaved: 0,
			};
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					options: {
						...rawMergeOptions,
						groomContext: true,
					},
				})
			)
		);

		expect(mergeResult).toEqual({ success: false, error: 'Merge cancelled' });
		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('does not publish an error state when grooming rejects after cancellation', async () => {
		const { result } = renderHook(() => useMergeSession('source-tab'));
		groomingMocks.groomContexts.mockImplementation(async () => {
			result.current.cancelTab('source-tab');
			throw new Error('late groom failure');
		});

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					options: {
						...rawMergeOptions,
						groomContext: true,
					},
				})
			)
		);

		expect(mergeResult).toEqual({ success: false, error: 'late groom failure' });
		expect(result.current.getTabMergeState('source-tab')).toBeNull();
		expect(groomingMocks.cancelGrooming).toHaveBeenCalledTimes(1);
		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('records grooming failures as merge errors', async () => {
		groomingMocks.groomContexts.mockResolvedValue({
			success: false,
			error: '',
			groomedLogs: [],
			tokensSaved: 0,
		});
		const { result } = renderHook(() => useMergeSession('source-tab'));

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					options: {
						...rawMergeOptions,
						groomContext: true,
					},
				})
			)
		);

		expect(mergeResult).toEqual({ success: false, error: 'Grooming failed' });
		expect(result.current.getTabMergeState('source-tab')?.state).toBe('error');
		expect(result.current.getTabMergeState('source-tab')?.error).toBe('Grooming failed');
	});

	it('reports unknown errors for non-Error grooming rejections', async () => {
		groomingMocks.groomContexts.mockRejectedValue('string failure');
		const { result } = renderHook(() => useMergeSession('source-tab'));

		const mergeResult = await act(async () =>
			result.current.startMerge(
				makeRequest({
					options: {
						...rawMergeOptions,
						groomContext: true,
					},
				})
			)
		);

		expect(mergeResult).toEqual({
			success: false,
			error: 'Unknown error during merge',
		});
		expect(result.current.getTabMergeState('source-tab')?.error).toBe('Unknown error during merge');
	});

	it('exposes the test reset utility for the global merge flag', () => {
		useOperationStore.getState().setGlobalMergeInProgress(true);

		__resetMergeInProgress?.();

		expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
	});

	it('does not expose the reset utility outside the test environment', async () => {
		const originalNodeEnv = process.env.NODE_ENV;
		vi.resetModules();
		vi.stubEnv('NODE_ENV', 'production');

		try {
			const module = await import('../../../../renderer/hooks/agent/useMergeSession');
			expect(module.__resetMergeInProgress).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
			vi.resetModules();
		}
	});
});

describe('useMergeSessionWithSessions', () => {
	beforeEach(() => {
		useOperationStore.getState().resetAll();
		groomingMocks.groomContexts.mockReset();
		groomingMocks.cancelGrooming.mockReset();
		(window as any).maestro = {
			history: {
				add: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	it('returns a failure when the target session is not found', async () => {
		const sourceSession = makeSession({ id: 'source-session' });
		let sessionsState: Session[] = [sourceSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessionsState = typeof updater === 'function' ? updater(sessionsState) : updater;
		});
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions: sessionsState,
				setSessions,
				activeTabId: 'tab-1',
			})
		);

		const mergeResult = await act(async () =>
			result.current.executeMerge(
				sourceSession,
				'tab-1',
				'missing-session',
				undefined,
				rawMergeOptions
			)
		);

		expect(mergeResult).toEqual({
			success: false,
			error: 'Target session not found: missing-session',
		});
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('adds a newly created merged session and notifies the caller', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		(window.maestro.history.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('history unavailable')
		);
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			aiTabs: [makeTab({ id: 'source-tab', logs: [makeLog('source-log', 'source', 2)] })],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: 'Target Session',
			aiTabs: [makeTab({ id: 'target-tab', logs: [makeLog('target-log', 'target', 1, 'ai')] })],
			activeTabId: 'target-tab',
		});
		let sessionsState: Session[] = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessionsState = typeof updater === 'function' ? updater(sessionsState) : updater;
		});
		const onSessionCreated = vi.fn();
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions: sessionsState,
				setSessions,
				activeTabId: 'source-tab',
				onSessionCreated,
			})
		);

		const mergeResult = await act(async () =>
			result.current.executeMerge(
				sourceSession,
				'source-tab',
				'target-session',
				'target-tab',
				newSessionOptions
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(sessionsState).toHaveLength(3);
		expect(sessionsState[2].name).toBe('Merged: Source Session + Target Session');
		expect(sessionsState[2].aiTabs[0].logs.map((log) => log.id)).toEqual([
			'target-log',
			'source-log',
		]);
		expect(window.maestro.history.add).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'AUTO',
				summary: 'Merged contexts from Source Session, Target Session',
				sessionId: sessionsState[2].id,
				projectPath: sourceSession.projectRoot,
				sessionName: 'Merged: Source Session + Target Session',
			})
		);
		expect(consoleWarn).toHaveBeenCalledWith(
			'Failed to log merge operation to history:',
			expect.any(Error)
		);
		expect(onSessionCreated).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: sessionsState[2].id,
				sessionName: 'Merged: Source Session + Target Session',
			})
		);
		expect(mergeResult.newSessionId).toBe(sessionsState[2].id);
		expect(mergeResult.newTabId).toBe(sessionsState[2].activeTabId);
	});

	it('injects source context into an existing target tab and logs history failures as non-fatal', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		(window.maestro.history.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('history unavailable')
		);
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			aiTabs: [
				makeTab({
					id: 'source-tab',
					logs: [
						makeLog('source-user', 'please keep this', 1, 'user'),
						makeLog('source-ai', 'assistant context', 2, 'ai'),
						makeLog('source-system', 'internal status', 3, 'system'),
						makeLog('source-empty', '   ', 4, 'user'),
					],
				}),
			],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: 'Target Session',
			projectRoot: '/repo/target',
			aiTabs: [
				makeTab({ id: 'other-tab', logs: [makeLog('other-log', 'other', 9)] }),
				makeTab({ id: 'target-tab', logs: [makeLog('target-log', 'target', 10)] }),
			],
			activeTabId: 'target-tab',
		});
		let sessionsState: Session[] = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessionsState = typeof updater === 'function' ? updater(sessionsState) : updater;
		});
		const onMergeComplete = vi.fn();
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions: sessionsState,
				setSessions,
				activeTabId: 'source-tab',
				onMergeComplete,
			})
		);

		const mergeResult = await act(async () =>
			result.current.executeMerge(
				sourceSession,
				'source-tab',
				'target-session',
				'target-tab',
				rawMergeOptions
			)
		);

		const updatedTarget = sessionsState.find((session) => session.id === 'target-session');
		const updatedTab = updatedTarget?.aiTabs.find((tab) => tab.id === 'target-tab');
		const untouchedTab = updatedTarget?.aiTabs.find((tab) => tab.id === 'other-tab');

		expect(mergeResult.success).toBe(true);
		expect(untouchedTab?.logs).toEqual([makeLog('other-log', 'other', 9)]);
		expect(updatedTab?.logs.at(-1)?.text).toBe('Context merged from "Source Session".');
		expect(updatedTab?.pendingMergedContext).toContain('User: please keep this');
		expect(updatedTab?.pendingMergedContext).toContain('Assistant: assistant context');
		expect(updatedTab?.pendingMergedContext).not.toContain('internal status');
		expect(updatedTab?.inputValue).toContain(
			'I\'m merging context from another session ("Source Session")'
		);
		expect(updatedTab?.autoSendOnActivate).toBe(true);
		expect(consoleWarn).toHaveBeenCalledWith(
			'Failed to log merge operation to history:',
			expect.any(Error)
		);
		expect(consoleLog).toHaveBeenCalledWith(
			'[MergeSession] Injected context into target tab:',
			expect.objectContaining({
				targetSessionId: 'target-session',
				targetTabId: 'target-tab',
				sourceSession: 'Source Session',
			})
		);
		expect(onMergeComplete).toHaveBeenCalledWith('source-tab', mergeResult);
	});

	it('injects an existing target tab without callbacks when source context is empty and groomed', async () => {
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		groomingMocks.groomContexts.mockResolvedValue({
			success: true,
			groomedLogs: [],
			tokensSaved: 0,
		});
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			aiTabs: [
				makeTab({
					id: 'source-tab',
					logs: [
						makeLog('source-system', 'internal status', 3, 'system'),
						makeLog('source-empty', '   ', 4, 'user'),
					],
				}),
			],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: 'Target Session',
			aiTabs: [makeTab({ id: 'target-tab', logs: [makeLog('target-log', 'target', 10)] })],
			activeTabId: 'target-tab',
		});
		let sessionsState: Session[] = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessionsState = typeof updater === 'function' ? updater(sessionsState) : updater;
		});
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions: sessionsState,
				setSessions,
				activeTabId: 'source-tab',
			})
		);

		const mergeResult = await act(async () =>
			result.current.executeMerge(sourceSession, 'source-tab', 'target-session', 'target-tab', {
				...rawMergeOptions,
				groomContext: true,
			})
		);

		const updatedTarget = sessionsState.find((session) => session.id === 'target-session');
		const updatedTab = updatedTarget?.aiTabs.find((tab) => tab.id === 'target-tab');

		expect(mergeResult.success).toBe(true);
		expect(updatedTab?.pendingMergedContext).toBeUndefined();
		expect(updatedTab?.logs.at(-1)?.text).toBe(
			'Context merged from "Source Session" (cleaned to reduce size).'
		);
		expect(consoleLog).toHaveBeenCalledWith(
			'[MergeSession] Injected context into target tab:',
			expect.objectContaining({ targetSessionId: 'target-session' })
		);
	});

	it('returns base merge failures from the session wrapper without mutating sessions', async () => {
		const sourceSession = makeSession({ id: 'source-session' });
		const targetSession = makeSession({ id: 'target-session' });
		let sessionsState: Session[] = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessionsState = typeof updater === 'function' ? updater(sessionsState) : updater;
		});
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions: sessionsState,
				setSessions,
				activeTabId: 'source-tab',
			})
		);

		const mergeResult = await act(async () =>
			result.current.executeMerge(
				sourceSession,
				'missing-source-tab',
				'target-session',
				'target-tab',
				rawMergeOptions
			)
		);

		expect(mergeResult).toEqual({
			success: false,
			error: 'Source tab not found',
		});
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('creates a merged session without requiring an onSessionCreated callback', async () => {
		const sourceSession = makeSession({
			id: 'source-session',
			name: 'Source Session',
			aiTabs: [makeTab({ id: 'source-tab', logs: [makeLog('source-log', 'source', 2)] })],
			activeTabId: 'source-tab',
		});
		const targetSession = makeSession({
			id: 'target-session',
			name: 'Target Session',
			aiTabs: [makeTab({ id: 'target-tab', logs: [makeLog('target-log', 'target', 1, 'ai')] })],
			activeTabId: 'target-tab',
		});
		let sessionsState: Session[] = [sourceSession, targetSession];
		const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
			sessionsState = typeof updater === 'function' ? updater(sessionsState) : updater;
		});
		const { result } = renderHook(() =>
			useMergeSessionWithSessions({
				sessions: sessionsState,
				setSessions,
				activeTabId: 'source-tab',
			})
		);

		const mergeResult = await act(async () =>
			result.current.executeMerge(
				sourceSession,
				'source-tab',
				'target-session',
				undefined,
				newSessionOptions
			)
		);

		expect(mergeResult.success).toBe(true);
		expect(sessionsState).toHaveLength(3);
		expect(sessionsState[2].name).toBe('Merged: Source Session + Target Session');
	});
});
