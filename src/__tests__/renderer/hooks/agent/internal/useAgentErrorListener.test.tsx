import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentErrorListener } from '../../../../../renderer/hooks/agent/internal/useAgentErrorListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { DEFAULT_BATCH_STATE } from '../../../../../renderer/hooks/batch/batchReducer';
import {
	useRetryStore,
	noteDispatch,
	cancelRetry,
	cancelContextCompaction,
	noteFailedTurnExited,
	registerBatchResumer,
	scheduleRetryForError,
	retryNow,
	getRetryEntry,
	getOutage,
} from '../../../../../renderer/stores/retryStore';
import { useAgentStore } from '../../../../../renderer/stores/agentStore';
import { registerContextCompactionSpawner } from '../../../../../renderer/services/contextCompaction';
import { useAuthOutageStore } from '../../../../../renderer/stores/authOutageStore';
import * as runtimeContext from '../../../../../renderer/utils/runtimeContext';
import { useSshOutageStore } from '../../../../../renderer/stores/sshOutageStore';
import {
	armEffortFallback,
	settleEffortFallback,
} from '../../../../../renderer/services/effortRejection';
import { resetEffortRejections } from '../../../../../shared/effortRejection';
import { resolveEffortLevel } from '../../../../../shared/modelTiers';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';

let handler: ((sessionId: string, error: any) => void) | undefined;
let authExpiredHandler: ((payload: any) => void) | undefined;
const mockUnsubscribe = vi.fn();
const mockAuthUnsubscribe = vi.fn();

const mockProcess = {
	onAgentError: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
	onAuthExpired: vi.fn((h: any) => {
		authExpiredHandler = h;
		return mockAuthUnsubscribe;
	}),
};

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

const baseError = {
	type: 'auth_expired',
	message: 'expired',
	timestamp: 1700000000000,
	agentId: 'claude-code',
	recoverable: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	authExpiredHandler = undefined;
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	useModalStore.getState().closeAll();
	useAuthOutageStore.setState({ outages: {} });
	useRetryStore.setState({ retries: {}, outages: {} });
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

const overloadError = {
	type: 'rate_limited',
	message: 'API Error: 529 Overloaded',
	timestamp: 1700000000000,
	agentId: 'claude-code',
	recoverable: true,
};

const contextLimitError = {
	type: 'token_exhaustion',
	message: 'Prompt is too long. Try a shorter message or start a new session.',
	timestamp: 1700000000000,
	agentId: 'claude-code',
	recoverable: true,
};

function seedSnapshot(sessionId: string, tabId: string) {
	noteDispatch(
		sessionId,
		{ id: 'item-1', timestamp: 1, tabId, type: 'message', text: 'hi' },
		{ conductorProfile: '', customAICommands: [], speckitCommands: [], openspecCommands: [] }
	);
}

function makeDeps() {
	return {
		getBatchStateRef: { current: null },
		pauseBatchOnErrorRef: { current: null },
		addHistoryEntryRef: { current: null },
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

describe('useAgentErrorListener', () => {
	it('opens the agentError modal and stamps session error state', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'agent_crashed' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('error');
		expect(updated.agentError?.type).toBe('agent_crashed');
		expect(updated.aiTabs[0].agentError?.type).toBe('agent_crashed');

		const modal = useModalStore.getState();
		const agentErrorEntry = modal.modals.get('agentError');
		expect(agentErrorEntry).toBeDefined();
		expect(agentErrorEntry?.data).toEqual({ sessionId: 'sess-1' });
	});
	it('renders remote errors without scheduling a second host retry', () => {
		const remote = vi.spyOn(runtimeContext, 'isWebDesktop').mockReturnValue(true);
		const tab = createMockAITab({ id: 'remote-tab' });
		const session = createMockSession({
			id: 'remote-agent',
			aiTabs: [tab],
			activeTabId: 'remote-tab',
		});
		useSessionStore.setState({ sessions: [session] });
		seedSnapshot('remote-agent', 'remote-tab');
		const { unmount } = renderHook(() => useAgentErrorListener(makeDeps()));
		try {
			handler!('remote-agent-ai-remote-tab', overloadError);
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.agentError?.message).toBe(overloadError.message);
			expect(updated.aiTabs[0].logs.find((log) => log.source === 'error')?.text).toBe(
				overloadError.message
			);
			expect(useRetryStore.getState().retries).toEqual({});
		} finally {
			unmount();
			remote.mockRestore();
		}
	});

	// Main sends a failed turn's last output ahead of its error. That output is
	// still in the renderer's batch when the error lands, so it has to be flushed
	// first or the card is appended above the text it ends.
	it('flushes batched output before appending the error card', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		let logsAtFlush: number | undefined;
		deps.batchedUpdater.flushNow.mockImplementation(() => {
			logsAtFlush = useSessionStore.getState().sessions[0].aiTabs[0].logs.length;
		});
		renderHook(() => useAgentErrorListener(deps));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'agent_crashed' });

		expect(deps.batchedUpdater.flushNow).toHaveBeenCalledTimes(1);
		expect(logsAtFlush).toBe(0);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
	});

	// An expired token downs every agent and pipeline on the provider at once,
	// so it skips the generic error modal and goes straight to the login flow.
	it('routes auth_expired to the reauth modal instead of the agentError modal', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const modal = useModalStore.getState();
		expect(modal.modals.get('agentError')?.open ?? false).toBe(false);
		// Addressed by provider, not by agent - one login fixes every agent on it.
		expect(modal.modals.get('reauth')?.data).toEqual({ providerKey: 'claude-code' });
		// The session still carries the error so the transcript and Left Bar agree.
		expect(useSessionStore.getState().sessions[0].agentError?.type).toBe('auth_expired');
		// The failing tab is recorded now so the resume can replay exactly it.
		expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toEqual([
			{ sessionId: 'sess-1', tabIds: ['tab-1'] },
		]);
	});

	// The whole point of the provider scope: 30 agents on one expired token is
	// one problem with one fix, not 30 dialogs.
	it('raises ONE prompt for many agents sharing an expired provider', () => {
		const sessions = Array.from({ length: 30 }, (_, i) =>
			createMockSession({
				id: `sess-${i}`,
				toolType: 'claude-code',
				aiTabs: [createMockAITab({ id: `tab-${i}` })],
				activeTabId: `tab-${i}`,
			})
		);
		useSessionStore.setState({ sessions } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		let opens = 0;
		const unsub = useModalStore.subscribe((state, prev) => {
			if (state.modals.get('reauth') !== prev.modals.get('reauth')) opens++;
		});
		sessions.forEach((s, i) => handler!(`${s.id}-ai-tab-${i}`, baseError));
		unsub();

		expect(opens).toBe(1);
		// ...but every one of them is on the roster, or its queued work could
		// never be resumed.
		expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toHaveLength(30);
	});

	it('keeps a different provider on its own prompt', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'sess-claude',
					toolType: 'claude-code',
					aiTabs: [createMockAITab({ id: 'tab-1' })],
					activeTabId: 'tab-1',
				}),
				createMockSession({
					id: 'sess-codex',
					toolType: 'codex',
					aiTabs: [createMockAITab({ id: 'tab-2' })],
					activeTabId: 'tab-2',
				}),
			],
		} as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-claude-ai-tab-1', baseError);
		handler!('sess-codex-ai-tab-2', baseError);

		const outages = useAuthOutageStore.getState().outages;
		expect(Object.keys(outages).sort()).toEqual(['claude-code', 'codex']);
	});

	// Cue spawns its agents outside the ProcessManager, so a pipeline auth
	// failure arrives on its own channel - and that is the case where a silent
	// failure costs the most.
	it('folds a pipeline auth failure into the same provider outage', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		authExpiredHandler!({
			sessionId: 'sess-1',
			agentId: 'claude-code',
			message: 'OAuth token has expired.',
			fromPipeline: true,
		});

		expect(useModalStore.getState().modals.get('reauth')?.data).toEqual({
			providerKey: 'claude-code',
		});
		const outage = useAuthOutageStore.getState().outages['claude-code'];
		expect(outage.fromPipeline).toBe(true);
		// A pipeline run owns no AI tab, so there is no turn to replay for it.
		expect(outage.blocked).toEqual([{ sessionId: 'sess-1', tabIds: [] }]);
	});

	it('ignores a pipeline auth failure for an agent that no longer exists', () => {
		useSessionStore.setState({ sessions: [] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		authExpiredHandler!({
			sessionId: 'deleted',
			agentId: 'claude-code',
			message: 'OAuth token has expired.',
		});

		expect(useModalStore.getState().modals.get('reauth')?.open ?? false).toBe(false);
	});

	it('clears stale agentSessionId on session_not_found', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'old-id' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBeNull();
		// Modal should NOT open for session_not_found
		const entry = useModalStore.getState().modals.get('agentError');
		expect(entry?.open ?? false).toBe(false);
	});

	it.each(['grok', undefined])(
		'preserves a failed Grok resume and shows its error (event provider: %s)',
		(agentId) => {
			const tab = createMockAITab({
				id: 'grok-tab',
				agentSessionId: 'grok-native-id',
				turnProvider: 'grok',
				logs: [{ id: 'user-log', timestamp: 1, source: 'user', text: 'continue my work' }],
				usageStats: {
					inputTokens: 31,
					outputTokens: 7,
					cacheReadInputTokens: 9,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.25,
					contextWindow: 200000,
				},
			});
			const activeTab = createMockAITab({ id: 'active-tab', agentSessionId: 'other-native-id' });
			const session = createMockSession({
				id: 'grok-agent',
				toolType: 'grok',
				agentSessionId: 'grok-native-id',
				aiTabs: [tab, activeTab],
				activeTabId: activeTab.id,
				contextUsage: 37,
			});
			useSessionStore.setState({ sessions: [session] });
			seedSnapshot(session.id, tab.id);
			const deps = makeDeps();
			const error = {
				...baseError,
				agentId,
				type: 'session_not_found',
				message: 'Grok session missing',
			};
			renderHook(() => useAgentErrorListener(deps));

			handler!('grok-agent-ai-grok-tab', error);

			const updated = useSessionStore.getState().sessions[0];
			expect(updated).toMatchObject({
				toolType: 'grok',
				agentSessionId: 'grok-native-id',
				contextUsage: 37,
				state: 'error',
				agentErrorPaused: true,
				agentErrorTabId: tab.id,
				agentError: error,
			});
			expect(updated.aiTabs[0].agentSessionId).toBe(tab.agentSessionId);
			expect(updated.aiTabs[0].usageStats).toEqual(tab.usageStats);
			expect(updated.aiTabs[0].logs.slice(0, -1)).toEqual(tab.logs);
			expect(updated.aiTabs[0].logs.at(-1)).toMatchObject({
				source: 'error',
				text: error.message,
				agentError: error,
			});
			expect(updated.aiTabs[0].logs.at(-1)?.recoveryAction).toBeUndefined();
			expect(updated.aiTabs[0].agentError).toMatchObject(error);
			expect(updated.aiTabs[1]).toEqual(activeTab);
			expect(deps.batchedUpdater.updateContextUsage).not.toHaveBeenCalled();
			expect(useRetryStore.getState().retries).toEqual({});
			expect(useModalStore.getState().modals.get('agentError')).toMatchObject({
				open: true,
				data: { sessionId: session.id },
			});
		}
	);

	it.each([
		{
			target: 'grok-agent-ai-grok-tab',
			agentId: 'grok',
			turnProvider: 'grok' as const,
			append: true,
		},
		{
			target: 'grok-agent-ai-grok-tab',
			agentId: undefined,
			turnProvider: 'grok' as const,
			append: true,
		},
		{
			target: 'grok-agent-ai-grok-tab',
			agentId: 'grok',
			turnProvider: 'codex' as const,
			append: true,
		},
		{
			target: 'grok-agent-ai-closed-tab',
			agentId: 'grok',
			turnProvider: 'grok' as const,
			append: false,
		},
		{
			target: 'grok-agent-batch-1700000000000',
			agentId: 'grok',
			turnProvider: 'grok' as const,
			append: false,
		},
	])(
		'isolates late Grok errors after a provider switch: %j',
		({ target, agentId, turnProvider, append }) => {
			const tab = createMockAITab({
				id: 'grok-tab',
				agentSessionId: 'codex-native-id',
				turnProvider,
				logs: [{ id: 'retained-log', timestamp: 1, source: 'user', text: 'retained history' }],
				providerSessions: { grok: { agentSessionId: 'grok-native-id', customModel: 'grok-model' } },
			});
			const activeTab = createMockAITab({
				id: 'active-tab',
				agentSessionId: 'active-codex-id',
				state: 'busy',
			});
			const session = createMockSession({
				id: 'grok-agent',
				toolType: 'codex',
				state: 'busy',
				contextUsage: 43,
				agentSessionId: 'codex-native-id',
				aiTabs: [tab, activeTab],
				activeTabId: activeTab.id,
			});
			useSessionStore.setState({ sessions: [session] });
			const pause = vi.fn();
			const addHistory = vi.fn();
			const getBatch = vi.fn(() => ({
				...DEFAULT_BATCH_STATE,
				isRunning: true,
				errorPaused: false,
				documents: ['plan.md'],
				currentDocumentIndex: 0,
			}));
			const deps = {
				...makeDeps(),
				getBatchStateRef: { current: getBatch },
				pauseBatchOnErrorRef: { current: pause },
				addHistoryEntryRef: { current: addHistory },
			};
			deps.activeHiddenToolRef.current.set('grok-agent:grok-tab', { toolName: 'Read' });
			const retryBefore = useRetryStore.getState();
			const toastsBefore = useNotificationStore.getState().toasts;
			const error = {
				...baseError,
				agentId,
				type: 'session_not_found',
				message: 'Old Grok resume failed',
			};
			renderHook(() => useAgentErrorListener(deps));

			handler!(target, error);

			const updated = useSessionStore.getState().sessions[0];
			expect({ ...updated, aiTabs: session.aiTabs }).toEqual(session);
			expect(updated.aiTabs[1]).toEqual(activeTab);
			expect({ ...updated.aiTabs[0], logs: tab.logs }).toEqual(tab);
			expect(updated.aiTabs[0].logs.slice(0, tab.logs.length)).toEqual(tab.logs);
			expect(updated.aiTabs[0].logs).toHaveLength(tab.logs.length + Number(append));
			if (append) {
				expect(updated.aiTabs[0].logs.at(-1)).toMatchObject({
					source: 'error',
					text: error.message,
					agentError: error,
				});
				expect(updated.aiTabs[0].logs.at(-1)?.recoveryAction).toBeUndefined();
			}
			expect(deps.batchedUpdater.flushNow).toHaveBeenCalledTimes(Number(append));
			expect(deps.batchedUpdater.updateContextUsage).not.toHaveBeenCalled();
			expect(deps.activeHiddenToolRef.current.has('grok-agent:grok-tab')).toBe(true);
			expect(getBatch).not.toHaveBeenCalled();
			expect(pause).not.toHaveBeenCalled();
			expect(addHistory).not.toHaveBeenCalled();
			expect(useRetryStore.getState()).toBe(retryBefore);
			expect(useNotificationStore.getState().toasts).toBe(toastsBefore);
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
		}
	);

	it('stamps recoveryAction with the last user prompt on session_not_found', () => {
		const userLog = {
			id: 'log-user',
			timestamp: 100,
			source: 'user' as const,
			text: 'do the thing that died',
		};
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			logs: [userLog],
		});
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
		expect(systemEntry?.recoveryAction).toEqual({
			lastUserPrompt: 'do the thing that died',
			tabId: 'tab-1',
		});
	});

	it('omits recoveryAction when no user message exists yet', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'old-id', logs: [] });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
		expect(systemEntry?.recoveryAction).toBeUndefined();
	});

	it('appends an error log entry to the targeted tab', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog).toBeDefined();
		expect(errorLog?.text).toBe('expired');
	});

	it('tags the error log with renderStyle=text-stream when the session is interactive', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		} as any);
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog?.renderStyle).toBe('text-stream');
	});

	it('leaves renderStyle unset on API-mode (non-interactive) errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		} as any);
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', baseError);

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		const errorLog = tabAfter.logs.find((l) => l.source === 'error');
		expect(errorLog?.renderStyle).toBeUndefined();
	});

	it('deletes the activeHiddenToolRef entry on error', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });

		renderHook(() => useAgentErrorListener(deps));
		handler!('sess-1-ai-tab-1', baseError);

		expect(deps.activeHiddenToolRef.current.has('sess-1:tab-1')).toBe(false);
	});

	it('seeds auto-resume metadata and stashes the last prompt on a limit error', async () => {
		const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
		(window as any).maestro.agents = { getLimitResetAt };

		const userLog = {
			id: 'log-user',
			timestamp: 100,
			source: 'user' as const,
			text: 'do the rate-limited thing',
		};
		const tab = createMockAITab({ id: 'tab-1', logs: [userLog] });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'rate_limited', message: 'usage limit' });

		// Synchronous pause: error stamped, paused, retry counter seeded to 0.
		const paused = useSessionStore.getState().sessions[0];
		expect(paused.state).toBe('error');
		expect(paused.agentErrorPaused).toBe(true);
		expect(paused.agentError?.type).toBe('rate_limited');
		expect(paused.agentError?.resumeAttemptCount).toBe(0);

		// The captured prompt rides along on the error log so Phase 3 can re-fire it.
		const errorLog = paused.aiTabs[0].logs.find((l) => l.source === 'error');
		expect(errorLog?.recoveryAction).toEqual({
			lastUserPrompt: 'do the rate-limited thing',
			tabId: 'tab-1',
		});

		// Best-effort reset estimate is patched in asynchronously.
		expect(getLimitResetAt).toHaveBeenCalledWith('claude-code');
		await waitFor(() => {
			expect(useSessionStore.getState().sessions[0].agentError?.limitResetAt).toBe(1700000123456);
		});
	});

	it('does not stamp a local reset estimate on an SSH-backed session', async () => {
		const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
		(window as any).maestro.agents = { getLimitResetAt };

		const tab = createMockAITab({ id: 'tab-1' });
		// SSH-backed: the local usage snapshot reflects the wrong account, so the
		// estimate must be skipped and the session left to the interval fallback.
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			sshRemoteId: 'remote-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', { ...baseError, type: 'rate_limited', message: 'usage limit' });

		// Still pauses synchronously; only the local reset probe is skipped.
		const paused = useSessionStore.getState().sessions[0];
		expect(paused.agentErrorPaused).toBe(true);
		expect(getLimitResetAt).not.toHaveBeenCalled();
		expect(paused.agentError?.limitResetAt).toBeUndefined();
	});

	it('auto-retries a recoverable overload error and suppresses the modal', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);
		// A prompt must have been dispatched so there's something to resend.
		seedSnapshot('sess-1', 'tab-1');

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', overloadError);

		// No blocking error state / modal - the retry engine owns it.
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).not.toBe('error');
		expect(updated.agentError).toBeUndefined();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);

		// A retry was scheduled with the availability strategy.
		const entry = useRetryStore.getState().retries['sess-1:tab-1'];
		expect(entry?.strategy).toBe('availability');
		expect(entry?.attempt).toBe(0);

		// The transcript gets ONE outage-marker entry (a live status card anchor):
		// a non-blocking system entry carrying the outage id, not a red error frame.
		const markers = updated.aiTabs[0].logs.filter((l) => l.retryOutageId);
		expect(markers).toHaveLength(1);
		expect(markers[0].source).toBe('system');
		expect(markers[0].retryOutageId).toBe(entry?.outageId);
		expect(updated.aiTabs[0].logs.some((l) => l.source === 'error')).toBe(false);

		cancelRetry('sess-1', 'tab-1'); // clear the pending timer
	});

	it('collapses a continued outage into the single existing marker (no new entries)', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);
		seedSnapshot('sess-1', 'tab-1');

		renderHook(() => useAgentErrorListener(makeDeps()));
		// First failure → one marker appended.
		handler!('sess-1-ai-tab-1', overloadError);
		const outageId = useRetryStore.getState().retries['sess-1:tab-1']?.outageId;

		// A second failure for the same outage (the resend failed again) must NOT
		// append another transcript entry - the live card already covers it.
		handler!('sess-1-ai-tab-1', overloadError);

		const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
		const markers = logs.filter((l) => l.retryOutageId);
		expect(markers).toHaveLength(1);
		expect(markers[0].retryOutageId).toBe(outageId);

		cancelRetry('sess-1', 'tab-1');
	});

	it('auto-continues an Auto Run batch (resumes instead of pausing for the user)', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		// A running batch owns the turn; register the resume hook App normally wires.
		const resumer = vi.fn();
		registerBatchResumer(resumer);
		const pauseBatchOnError = vi.fn();
		const deps = {
			...makeDeps(),
			getBatchStateRef: {
				current: () => ({
					isRunning: true,
					errorPaused: false,
					documents: ['plan.md'],
					currentDocumentIndex: 0,
				}),
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		} as any;

		renderHook(() => useAgentErrorListener(deps));
		handler!('sess-1-ai-tab-1', overloadError);

		// The batch was parked (so the loop can be resumed) but the modal stays shut.
		expect(pauseBatchOnError).toHaveBeenCalled();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);

		// A batch-resume retry was scheduled (no prompt snapshot needed).
		const entry = useRetryStore.getState().retries['sess-1:tab-1'];
		expect(entry?.mode).toBe('batch-resume');
		expect(entry?.strategy).toBe('availability');

		cancelRetry('sess-1', 'tab-1');
		registerBatchResumer(null);
	});

	it('falls back to the error modal when there is no prompt to resend', () => {
		const tab = createMockAITab({ id: 'tab-2' });
		const session = createMockSession({ id: 'sess-2', aiTabs: [tab], activeTabId: 'tab-2' });
		useSessionStore.setState({ sessions: [session] } as any);
		// No seedSnapshot → nothing captured → cannot auto-retry.

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-2-ai-tab-2', overloadError);

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('error');
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(true);
		expect(useRetryStore.getState().retries['sess-2:tab-2']).toBeUndefined();
	});

	// An Auto Run task process owns no AI tab. Before this guard the tab fallback
	// resolved to getActiveTab(), so killing an Auto Run painted the batch's error
	// into the user's unrelated chat tab and flipped the whole agent to `error`.
	it('leaves the active chat tab alone when a running Auto Run errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const pauseBatchOnError = vi.fn();
		const deps = {
			...makeDeps(),
			getBatchStateRef: {
				current: () => ({
					isRunning: true,
					errorPaused: false,
					documents: ['plan.md'],
					currentDocumentIndex: 0,
				}),
			},
			pauseBatchOnErrorRef: { current: pauseBatchOnError },
		} as any;

		renderHook(() => useAgentErrorListener(deps));
		handler!('sess-1-batch-1700000000000', { ...baseError, type: 'agent_crashed' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).not.toBe('error');
		expect(updated.agentError).toBeUndefined();
		expect(updated.agentErrorPaused ?? false).toBe(false);
		expect(updated.aiTabs[0].logs).toHaveLength(tab.logs.length);
		expect(updated.aiTabs[0].agentError).toBeUndefined();

		// The Auto Run banner is the surface, not the blocking modal.
		expect(pauseBatchOnError).toHaveBeenCalled();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
	});

	// session_not_found nulls the target tab's agentSessionId. Borrowing the
	// active tab for a batch error severed an unrelated conversation's resume
	// chain, which is unrecoverable once the process is gone.
	it('never clears the active chat tab agentSessionId for a batch error', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		// No batch state registered: the straggler path still must not touch the tab.
		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-batch-1700000000000', { ...baseError, type: 'session_not_found' });

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('claude-abc');
		expect(updated.aiTabs[0].logs).toHaveLength(tab.logs.length);
	});

	// A full context window is fixed by compacting the session and resending, so
	// the failure itself must leave no mark: no error frame, no ERR badge, no
	// modal, no outage card. The compaction pill is the whole record.
	it('masks a context-limit error behind a compaction pill', () => {
		registerContextCompactionSpawner(vi.fn(() => new Promise<{ success: boolean }>(() => {})));
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);
		seedSnapshot('sess-1', 'tab-1');

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', contextLimitError);

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).not.toBe('error');
		expect(updated.agentError).toBeUndefined();
		expect(updated.aiTabs[0].agentError).toBeUndefined();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);

		const added = updated.aiTabs[0].logs.slice(tab.logs.length);
		expect(added).toHaveLength(1);
		expect(added[0].contextCompaction).toEqual({ status: 'pending' });
		expect(added[0].retryOutageId).toBeUndefined();

		expect(useRetryStore.getState().retries['sess-1:tab-1']?.strategy).toBe('context-compaction');
		expect(useRetryStore.getState().outages).toEqual({});

		cancelContextCompaction('sess-1');
		registerContextCompactionSpawner(null);
	});

	// The compaction could not land, so the retry store hands the SAME error back
	// through the handler this hook registered, and it shows as it always did.
	it('surfaces the context-limit error when the compaction fails', async () => {
		let failCompaction!: (result: { success: boolean; error?: string }) => void;
		registerContextCompactionSpawner(
			vi.fn(
				() =>
					new Promise<{ success: boolean; error?: string }>((resolve) => {
						failCompaction = resolve;
					})
			)
		);
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);
		seedSnapshot('sess-1', 'tab-1');

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-ai-tab-1', contextLimitError);
		noteFailedTurnExited('sess-1', 'tab-1');
		failCompaction({ success: false, error: 'Prompt is too long' });

		await waitFor(() => {
			expect(useSessionStore.getState().sessions[0].state).toBe('error');
		});
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.agentError?.type).toBe('token_exhaustion');
		expect(updated.aiTabs[0].logs.some((l) => l.source === 'error')).toBe(true);
		expect(updated.aiTabs[0].logs.find((l) => l.contextCompaction)?.contextCompaction).toEqual({
			status: 'error',
			error: 'Prompt is too long',
		});
		expect(useModalStore.getState().modals.get('agentError')?.open).toBe(true);
		expect(useRetryStore.getState().retries['sess-1:tab-1']).toBeUndefined();

		registerContextCompactionSpawner(null);
	});

	it('skips synopsis-process errors', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-1-synopsis', baseError);

		expect(useSessionStore.getState().sessions[0].state).not.toBe('error');
	});

	describe('effort refused by the provider', () => {
		// The API answering the effort a turn asked for with a 400. Codex dropped
		// `minimal` this way; the only trace was a tab that never got a name.
		const effortRefusal = {
			type: 'unknown',
			timestamp: 1700000000000,
			agentId: 'codex',
			recoverable: true,
			message:
				'{"type":"error","error":{"message":"Unsupported value: \'low\' is not supported with the \'gpt-6-astra\' model. Supported values are: \'medium\', \'high\'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}',
		};

		const runningBatchDeps = (pauseBatchOnError: ReturnType<typeof vi.fn>) =>
			({
				...makeDeps(),
				getBatchStateRef: {
					current: () => ({
						isRunning: true,
						errorPaused: false,
						documents: ['plan.md'],
						currentDocumentIndex: 0,
					}),
				},
				pauseBatchOnErrorRef: { current: pauseBatchOnError },
			}) as any;

		beforeEach(() => {
			resetEffortRejections();
			useNotificationStore.setState({ toasts: [] });
		});

		it('notes and toasts a refusal from a spawn this handler otherwise ignores', () => {
			// Tab naming runs in the main process under a synthetic id with no
			// session behind it. The refusal must not be silent just because of that.
			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('tab-naming-abc', effortRefusal);

			expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
			const toasts = useNotificationStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0].title).toBe('Codex rejected effort "low"');
		});

		it('notes a refusal from a synopsis, which returns before any other handling', () => {
			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-synopsis-1700000000000', effortRefusal);

			expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
		});

		it('leaves a running Auto Run alone when its task is armed to retry itself', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] } as any);
			const pauseBatchOnError = vi.fn();

			armEffortFallback('sess-1-batch-1700000000000');
			renderHook(() => useAgentErrorListener(runningBatchDeps(pauseBatchOnError)));
			handler!('sess-1-batch-1700000000000', effortRefusal);

			// Parking the run behind an error banner for a task that is about to be
			// re-run would stop the run the retry is trying to save.
			expect(pauseBatchOnError).not.toHaveBeenCalled();
			expect(useSessionStore.getState().sessions[0].state).not.toBe('error');
			// The refusal is held for the spawn's exit handler to collect.
			expect(settleEffortFallback('sess-1-batch-1700000000000')?.value).toBe('low');
		});

		it('still parks the Auto Run when the task is not armed', () => {
			// No effort override was sent, so nothing will retry: the refusal is of
			// the agent's own setting and the user has to see it.
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] } as any);
			const pauseBatchOnError = vi.fn();

			renderHook(() => useAgentErrorListener(runningBatchDeps(pauseBatchOnError)));
			handler!('sess-1-batch-1700000000001', effortRefusal);

			expect(pauseBatchOnError).toHaveBeenCalled();
		});

		it('still surfaces the refusal on an ordinary tab turn', () => {
			// The user picked this effort on the tab. Their turn fails with the
			// provider's own message; nothing here rewrites their choice.
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', effortRefusal);

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('error');
			expect(updated.aiTabs[0].agentError?.message).toContain('Unsupported value');
		});
	});

	/**
	 * Grok errors as the desktop delivers them: the event carries no
	 * host dispatch facts, so the listener cannot prove a prompt never reached
	 * Grok and must surface the refusal instead of replaying it. The reset
	 * estimator is Claude-only, so a Grok limit keeps an unknown reset.
	 */
	describe('Grok retry and error surfacing', () => {
		const DEPS = {
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		};
		const PROMPT = 'rerun the flaky suite and report the first failure';
		const grokError = (partial: Record<string, unknown>) => ({
			type: 'rate_limited',
			message: 'Rate limit exceeded. Please try again later.',
			timestamp: 1700000000000,
			agentId: 'grok',
			recoverable: true,
			...partial,
		});
		let processQueuedItem: ReturnType<typeof vi.fn>;

		function setupGrok(id: string) {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'grok-native-11a',
				logs: [{ id: 'u1', timestamp: 1, source: 'user', text: PROMPT }],
			});
			const session = createMockSession({
				id,
				toolType: 'grok',
				customEnvVars: { GROK_HOME: '/accounts/grok-11a' },
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session] } as any);
			noteDispatch(
				id,
				{ id: `turn-${id}`, timestamp: 1, tabId: 'tab-1', type: 'message', text: PROMPT },
				DEPS
			);
		}

		beforeEach(() => {
			processQueuedItem = vi.fn().mockResolvedValue(true);
			useAgentStore.setState({ processQueuedItem } as any);
		});

		it('surfaces a Grok rate limit with an unknown reset instead of replaying it', async () => {
			// Main answers undefined for every provider but Claude Code.
			const getLimitResetAt = vi.fn().mockResolvedValue(undefined);
			(window as any).maestro.agents = { getLimitResetAt };
			setupGrok('grok-a');

			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('grok-a-ai-tab-1', grokError({}));

			expect(useRetryStore.getState().retries['grok-a:tab-1']).toBeUndefined();
			expect(useRetryStore.getState().outages).toEqual({});
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(true);
			const paused = useSessionStore.getState().sessions[0];
			expect(paused.state).toBe('error');
			expect(paused.agentError).toMatchObject({
				type: 'rate_limited',
				agentId: 'grok',
				resumeAttemptCount: 0,
			});
			// The original prompt rides on the error for a user-driven resume, on the same tab.
			const errorLog = paused.aiTabs[0].logs.find((l) => l.source === 'error');
			expect(errorLog?.recoveryAction).toEqual({ lastUserPrompt: PROMPT, tabId: 'tab-1' });
			expect(paused.aiTabs[0].agentSessionId).toBe('grok-native-11a');
			expect(paused.customEnvVars).toEqual({ GROK_HOME: '/accounts/grok-11a' });

			await waitFor(() => expect(getLimitResetAt).toHaveBeenCalledWith('grok'));
			await Promise.resolve();
			expect(useSessionStore.getState().sessions[0].agentError?.limitResetAt).toBeUndefined();
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('keeps a reset the Grok refusal reported off the estimator stamp', async () => {
			const getLimitResetAt = vi.fn().mockResolvedValue(undefined);
			(window as any).maestro.agents = { getLimitResetAt };
			setupGrok('grok-b');

			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!(
				'grok-b-ai-tab-1',
				grokError({ message: 'Usage limit reached. Retry after 20 seconds.' })
			);

			await waitFor(() => expect(getLimitResetAt).toHaveBeenCalledTimes(1));
			await Promise.resolve();
			const paused = useSessionStore.getState().sessions[0];
			// The message is kept verbatim for the user; nothing invents a stamp from it.
			expect(paused.agentError?.message).toBe('Usage limit reached. Retry after 20 seconds.');
			expect(paused.agentError?.limitResetAt).toBeUndefined();
			expect(useRetryStore.getState().retries['grok-b:tab-1']).toBeUndefined();
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('routes a Grok auth refusal to re-authentication with no retry', () => {
			setupGrok('grok-c');
			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!(
				'grok-c-ai-tab-1',
				grokError({ type: 'auth_expired', message: 'Grok credentials have expired.' })
			);

			const modal = useModalStore.getState();
			expect(modal.modals.get('agentError')?.open ?? false).toBe(false);
			expect(modal.modals.get('reauth')?.open).toBe(true);
			expect(useSessionStore.getState().sessions[0].agentError?.type).toBe('auth_expired');
			expect(useRetryStore.getState().retries['grok-c:tab-1']).toBeUndefined();
			expect(useRetryStore.getState().outages).toEqual({});
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('surfaces an unavailable Grok provider and keeps its native session', () => {
			setupGrok('grok-d');
			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!(
				'grok-d-ai-tab-1',
				grokError({ type: 'agent_crashed', message: 'Grok ACP could not start: spawn grok ENOENT' })
			);

			const session = useSessionStore.getState().sessions[0];
			expect(session.state).toBe('error');
			expect(session.agentError?.type).toBe('agent_crashed');
			expect(session.aiTabs[0].agentSessionId).toBe('grok-native-11a');
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(true);
			expect(useRetryStore.getState().retries['grok-d:tab-1']).toBeUndefined();
			expect(processQueuedItem).not.toHaveBeenCalled();
		});

		it('ends an in-flight Grok resend on a late error and never sends a second one', () => {
			setupGrok('grok-e');
			// A resend already on the wire, scheduled on host facts the desktop event lacks.
			const notDispatched = {
				...grokError({}),
				terminal: { status: 'failed', kind: 'provider', dispatchState: 'not-dispatched' },
			};
			expect(scheduleRetryForError('grok-e', 'tab-1', notDispatched as never)).toBe(true);
			retryNow('grok-e', 'tab-1');
			expect(processQueuedItem).toHaveBeenCalledTimes(1);
			const outageId = getRetryEntry('grok-e', 'tab-1')!.outageId;

			renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('grok-e-ai-tab-1', grokError({}));
			// The same late error delivered again.
			handler!('grok-e-ai-tab-1', grokError({}));

			expect(processQueuedItem).toHaveBeenCalledTimes(1);
			expect(useRetryStore.getState().retries['grok-e:tab-1']).toBeUndefined();
			expect(getOutage(outageId)?.status).toBe('failed');
			expect(useSessionStore.getState().sessions[0].agentError?.agentId).toBe('grok');
		});
	});
});

describe('useAgentErrorListener - SSH transport errors', () => {
	const sshError = {
		type: 'network_error',
		message: 'Unable to connect to "pedtome" over SSH. Connection closed by UNKNOWN port 65535',
		timestamp: 1700000000000,
		agentId: 'claude-code',
		recoverable: true,
		sshRemoteId: 'remote-1',
	};

	// Its own agent id: an earlier test's dispatch snapshot for `sess-1` would
	// make Agent Resilience auto-retry these and suppress every modal.
	function seedSshSession() {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-ssh', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);
	}

	function mockReachability(reachable: boolean) {
		const checkReachability = vi.fn().mockResolvedValue({
			success: true,
			reachable,
			event: reachable
				? undefined
				: {
						remoteId: 'remote-1',
						remoteName: 'pedtome',
						reachable: false,
						message: sshError.message,
						since: 1,
					},
		});
		(window as any).maestro = {
			...(window as any).maestro,
			sshRemote: { ...((window as any).maestro?.sshRemote || {}), checkReachability },
		};
		return checkReachability;
	}

	beforeEach(() => {
		useSshOutageStore.setState({ outages: {} });
	});

	it('leaves the per-agent modal closed when the remote is confirmed down (the outage dialog covers it)', async () => {
		seedSshSession();
		const check = mockReachability(false);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-ssh-ai-tab-1', sshError);

		await waitFor(() => expect(check).toHaveBeenCalledWith('remote-1'));
		await waitFor(() =>
			expect(useSshOutageStore.getState().outages['remote-1']?.event.remoteName).toBe('pedtome')
		);
		// A live turn died on it: surfaced, so the dialog shows wherever the user is.
		await waitFor(() =>
			expect(useSshOutageStore.getState().outages['remote-1']?.surfaced).toBe(true)
		);
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
		// The tab still records the failure.
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentError?.type).toBe('network_error');
	});

	it('falls back to the per-agent modal when the host answers (a one-off drop)', async () => {
		seedSshSession();
		mockReachability(true);

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-ssh-ai-tab-1', sshError);

		await waitFor(() =>
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(true)
		);
	});

	it('does not probe again for a remote already in an outage', async () => {
		seedSshSession();
		const check = mockReachability(false);
		useSshOutageStore.getState().applyReachability({
			remoteId: 'remote-1',
			remoteName: 'pedtome',
			reachable: false,
			since: 1,
		});

		renderHook(() => useAgentErrorListener(makeDeps()));
		handler!('sess-ssh-ai-tab-1', sshError);
		await Promise.resolve();

		expect(check).not.toHaveBeenCalled();
		expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
	});
});
