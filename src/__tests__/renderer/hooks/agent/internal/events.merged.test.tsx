// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/agent/internal/noteProviderModeTransition.test.ts
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentCommandExitListener.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentDataListener.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentErrorListener.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentSessionIdListener.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentSlashCommandsListener.test.tsx
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentStderrListener.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	noteProviderModeTransition,
	__resetAnnouncedProviderMode,
} from '../../../../../renderer/hooks/agent/internal/useAgentClaudeModeResolvedListener';
import { renderHook as s2_renderHook } from '@testing-library/react';
import { useAgentCommandExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentCommandExitListener';
import { useSessionStore as s2_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession as s2_createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab as s2_createMockAITab } from '../../../../helpers/mockTab';
import { renderHook as s3_renderHook } from '@testing-library/react';
import { useAgentDataListener } from '../../../../../renderer/hooks/agent/internal/useAgentDataListener';
import { useSessionStore as s3_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession as s3_createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab as s3_createMockAITab } from '../../../../helpers/mockTab';
import { useRetryStore as s3_useRetryStore } from '../../../../../renderer/stores/retryStore';
import type { BatchedUpdater as S3_BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';
import { renderHook as s4_renderHook, waitFor } from '@testing-library/react';
import { useAgentErrorListener } from '../../../../../renderer/hooks/agent/internal/useAgentErrorListener';
import { useSessionStore as s4_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { createMockSession as s4_createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab as s4_createMockAITab } from '../../../../helpers/mockTab';
import {
	useRetryStore as s4_useRetryStore,
	noteDispatch,
	cancelRetry,
	cancelContextCompaction,
	noteFailedTurnExited,
	registerBatchResumer,
} from '../../../../../renderer/stores/retryStore';
import { registerContextCompactionSpawner } from '../../../../../renderer/services/contextCompaction';
import { useAuthOutageStore } from '../../../../../renderer/stores/authOutageStore';
import * as runtimeContext from '../../../../../renderer/utils/runtimeContext';
import {
	armEffortFallback,
	settleEffortFallback,
} from '../../../../../renderer/services/effortRejection';
import { resetEffortRejections } from '../../../../../shared/effortRejection';
import { resolveEffortLevel } from '../../../../../shared/modelTiers';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';
import { renderHook as s5_renderHook } from '@testing-library/react';
import { useAgentSessionIdListener } from '../../../../../renderer/hooks/agent/internal/useAgentSessionIdListener';
import { useSessionStore as s5_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession as s5_createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab as s5_createMockAITab } from '../../../../helpers/mockTab';
import type { BatchedUpdater as S5_BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';
import { renderHook as s6_renderHook } from '@testing-library/react';
import { useAgentSlashCommandsListener } from '../../../../../renderer/hooks/agent/internal/useAgentSlashCommandsListener';
import { useSessionStore as s6_useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession as s6_createMockSession } from '../../../../helpers/mockSession';
import { renderHook as s7_renderHook } from '@testing-library/react';
import { useAgentStderrListener } from '../../../../../renderer/hooks/agent/internal/useAgentStderrListener';
import type { BatchedUpdater as S7_BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';
// Source: src/__tests__/renderer/hooks/agent/internal/noteProviderModeTransition.test.ts
describe('', () => {
	describe('noteProviderModeTransition', () => {
		beforeEach(() => {
			__resetAnnouncedProviderMode();
		});
		it('baselines the first observation per provider without announcing', () => {
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
				transitioned: false,
			});
		});
		it('does not announce when the mode is unchanged (the cascade: other agents follow silently)', () => {
			noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline
			// Three more agents on the same account resolve the same mode.
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
		});
		it('announces exactly once on a real account-wide transition, then cascades silently', () => {
			noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline
			// First agent to hit the limit flips the account to API → announce once.
			expect(noteProviderModeTransition('/Users/me/.claude', 'api')).toEqual({
				transitioned: true,
				prevMode: 'interactive',
			});
			// Every other agent on the same account that resolves API after the flip
			// must NOT re-announce.
			expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
			expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
		});
		it('announces the switch back to Time Limits once when the quota window resets', () => {
			noteProviderModeTransition('/Users/me/.claude', 'api'); // baseline (account already limited)
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
				transitioned: true,
				prevMode: 'api',
			});
			expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(
				false
			);
		});
		it('tracks each provider (account) independently', () => {
			noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline A
			noteProviderModeTransition('/Users/me/.claude-work', 'interactive'); // baseline B
			// Account A flips; account B is untouched.
			expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(true);
			expect(noteProviderModeTransition('/Users/me/.claude-work', 'interactive').transitioned).toBe(
				false
			);
			// Account B's own later flip announces on its own schedule.
			expect(noteProviderModeTransition('/Users/me/.claude-work', 'api').transitioned).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentCommandExitListener.test.tsx
describe('', () => {
	let handler: ((sessionId: string, code: number) => void) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onCommandExit: vi.fn((h: any) => {
			handler = h;
			return mockUnsubscribe;
		}),
	};
	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		s2_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});
	describe('useAgentCommandExitListener', () => {
		it('appends a system log on non-zero exit code', () => {
			const session = s2_createMockSession({ id: 'sess-1', shellLogs: [] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 2);
			const updated = s2_useSessionStore.getState().sessions[0];
			const sysLog = updated.shellLogs[updated.shellLogs.length - 1];
			expect(sysLog?.text).toContain('exited with code 2');
			expect(sysLog?.source).toBe('system');
		});
		it('does not append a log on zero exit code', () => {
			const session = s2_createMockSession({ id: 'sess-1', shellLogs: [] });
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 0);
			expect(s2_useSessionStore.getState().sessions[0].shellLogs).toEqual([]);
		});
		it('keeps session busy when an AI tab is still busy', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', state: 'busy' });
			const session = s2_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
			});
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 0);
			expect(s2_useSessionStore.getState().sessions[0].state).toBe('busy');
		});
		it('transitions session to idle when no AI tabs busy', () => {
			const tab = s2_createMockAITab({ id: 'tab-1', state: 'idle' });
			const session = s2_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				state: 'busy',
			});
			s2_useSessionStore.setState({ sessions: [session] } as any);
			s2_renderHook(() => useAgentCommandExitListener());
			handler!('sess-1', 0);
			expect(s2_useSessionStore.getState().sessions[0].state).toBe('idle');
		});
		it('skips no-op render when session is missing (orphan event)', () => {
			const setSessionsSpy = vi.spyOn(s2_useSessionStore.getState(), 'setSessions');
			s2_renderHook(() => useAgentCommandExitListener());
			handler!('missing', 0);
			expect(setSessionsSpy).not.toHaveBeenCalled();
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentDataListener.test.tsx
describe('', () => {
	let handler: ((sessionId: string, data: string) => void) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onData: vi.fn((h: any) => {
			handler = h;
			return mockUnsubscribe;
		}),
	};
	function makeBatched(): S3_BatchedUpdater {
		return {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
		};
	}
	function makeRef(): {
		current: Map<
			string,
			{
				toolName: string;
				toolState?: any;
			}
		>;
	} {
		return { current: new Map() };
	}
	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		s3_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcess,
			agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
		};
	});
	describe('useAgentDataListener', () => {
		it('routes ai-formatted ids through batched appendLog with isAi=true', () => {
			const tab = s3_createMockAITab({ id: 'tab-1' });
			const session = s3_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s3_useSessionStore.setState({ sessions: [session] } as any);
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1-ai-tab-1', 'hello\n');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'hello\n');
			expect(batched.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
			expect(batched.updateCycleBytes).toHaveBeenCalledWith('sess-1', 6);
		});
		it('routes plain session ids as terminal output', () => {
			const session = s3_createMockSession({ id: 'sess-1' });
			s3_useSessionStore.setState({ sessions: [session] } as any);
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1', 'terminal output');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'terminal output');
			expect(batched.markDelivered).not.toHaveBeenCalled();
		});
		it('drops empty terminal output', () => {
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1', '   ');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});
		it('ignores -terminal and -batch- session ids', () => {
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1-terminal', 'data');
			handler!('sess-1-batch-x', 'data');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});
		it('deletes the matching activeHiddenToolRef entry on first chunk', () => {
			const tab = s3_createMockAITab({ id: 'tab-1' });
			const session = s3_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s3_useSessionStore.setState({ sessions: [session] } as any);
			const ref = makeRef();
			ref.current.set('sess-1:tab-1', { toolName: 'Read' });
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: ref })
			);
			handler!('sess-1-ai-tab-1', 'data');
			expect(ref.current.has('sess-1:tab-1')).toBe(false);
		});
		it('clears lingering session.agentError on next data chunk', () => {
			const tab = s3_createMockAITab({ id: 'tab-1' });
			const session = s3_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				agentError: { type: 'auth_expired', message: 'expired', timestamp: 0 } as any,
				state: 'error',
			});
			s3_useSessionStore.setState({ sessions: [session] } as any);
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1-ai-tab-1', 'data');
			const updated = s3_useSessionStore.getState().sessions[0];
			expect(updated.agentError).toBeUndefined();
			expect(updated.state).toBe('busy');
		});
		// Claude prints "Prompt is too long" on the result envelope as ordinary
		// output, after the error that started the compaction recovery. Rendered, it
		// puts the failure the recovery is masking straight back into the transcript.
		it('drops output from a turn that failed on the context limit and is being re-run', () => {
			const tab = s3_createMockAITab({ id: 'tab-1' });
			const session = s3_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s3_useSessionStore.setState({ sessions: [session] } as any);
			s3_useRetryStore.setState({
				retries: {
					'sess-1:tab-1': {
						sessionId: 'sess-1',
						tabId: 'tab-1',
						key: 'sess-1:tab-1',
						outageId: 'o1',
						strategy: 'context-compaction',
						mode: 'resend',
						status: 'scheduled',
						attempt: 0,
						startedAt: 0,
						nextRetryAt: 0,
						lastMessage: 'Prompt is too long',
						compaction: { pill: null, error: {} as any, compacted: false },
					},
				},
				outages: {},
			});
			const batched = makeBatched();
			s3_renderHook(() =>
				useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
			);
			handler!('sess-1-ai-tab-1', 'Prompt is too long');
			expect(batched.appendLog).not.toHaveBeenCalled();
			// Once the compaction is under way the tab's next writer is the resend.
			s3_useRetryStore.setState((state) => ({
				retries: {
					'sess-1:tab-1': { ...state.retries['sess-1:tab-1'], status: 'in-flight' },
				},
			}));
			handler!('sess-1-ai-tab-1', 'Here is the answer.');
			expect(batched.appendLog).toHaveBeenCalledWith(
				'sess-1',
				'tab-1',
				true,
				'Here is the answer.'
			);
			s3_useRetryStore.setState({ retries: {}, outages: {} });
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentErrorListener.test.tsx
describe('', () => {
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
		current: Map<
			string,
			{
				toolName: string;
				toolState?: any;
			}
		>;
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
		s4_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		useModalStore.getState().closeAll();
		useAuthOutageStore.setState({ outages: {} });
		s4_useRetryStore.setState({ retries: {}, outages: {} });
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
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'agent_crashed' });
			const updated = s4_useSessionStore.getState().sessions[0];
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
			const tab = s4_createMockAITab({ id: 'remote-tab' });
			const session = s4_createMockSession({
				id: 'remote-agent',
				aiTabs: [tab],
				activeTabId: 'remote-tab',
			});
			s4_useSessionStore.setState({ sessions: [session] });
			seedSnapshot('remote-agent', 'remote-tab');
			const { unmount } = s4_renderHook(() => useAgentErrorListener(makeDeps()));
			try {
				handler!('remote-agent-ai-remote-tab', overloadError);
				const updated = s4_useSessionStore.getState().sessions[0];
				expect(updated.agentError?.message).toBe(overloadError.message);
				expect(updated.aiTabs[0].logs.find((log) => log.source === 'error')?.text).toBe(
					overloadError.message
				);
				expect(s4_useRetryStore.getState().retries).toEqual({});
			} finally {
				unmount();
				remote.mockRestore();
			}
		});
		// Main sends a failed turn's last output ahead of its error. That output is
		// still in the renderer's batch when the error lands, so it has to be flushed
		// first or the card is appended above the text it ends.
		it('flushes batched output before appending the error card', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			const deps = makeDeps();
			let logsAtFlush: number | undefined;
			deps.batchedUpdater.flushNow.mockImplementation(() => {
				logsAtFlush = s4_useSessionStore.getState().sessions[0].aiTabs[0].logs.length;
			});
			s4_renderHook(() => useAgentErrorListener(deps));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'agent_crashed' });
			expect(deps.batchedUpdater.flushNow).toHaveBeenCalledTimes(1);
			expect(logsAtFlush).toBe(0);
			expect(s4_useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(1);
		});
		// An expired token downs every agent and pipeline on the provider at once,
		// so it skips the generic error modal and goes straight to the login flow.
		it('routes auth_expired to the reauth modal instead of the agentError modal', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', baseError);
			const modal = useModalStore.getState();
			expect(modal.modals.get('agentError')?.open ?? false).toBe(false);
			// Addressed by provider, not by agent - one login fixes every agent on it.
			expect(modal.modals.get('reauth')?.data).toEqual({ providerKey: 'claude-code' });
			// The session still carries the error so the transcript and Left Bar agree.
			expect(s4_useSessionStore.getState().sessions[0].agentError?.type).toBe('auth_expired');
			// The failing tab is recorded now so the resume can replay exactly it.
			expect(useAuthOutageStore.getState().outages['claude-code'].blocked).toEqual([
				{ sessionId: 'sess-1', tabIds: ['tab-1'] },
			]);
		});
		// The whole point of the provider scope: 30 agents on one expired token is
		// one problem with one fix, not 30 dialogs.
		it('raises ONE prompt for many agents sharing an expired provider', () => {
			const sessions = Array.from({ length: 30 }, (_, i) =>
				s4_createMockSession({
					id: `sess-${i}`,
					toolType: 'claude-code',
					aiTabs: [s4_createMockAITab({ id: `tab-${i}` })],
					activeTabId: `tab-${i}`,
				})
			);
			s4_useSessionStore.setState({ sessions } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
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
			s4_useSessionStore.setState({
				sessions: [
					s4_createMockSession({
						id: 'sess-claude',
						toolType: 'claude-code',
						aiTabs: [s4_createMockAITab({ id: 'tab-1' })],
						activeTabId: 'tab-1',
					}),
					s4_createMockSession({
						id: 'sess-codex',
						toolType: 'codex',
						aiTabs: [s4_createMockAITab({ id: 'tab-2' })],
						activeTabId: 'tab-2',
					}),
				],
			} as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-claude-ai-tab-1', baseError);
			handler!('sess-codex-ai-tab-2', baseError);
			const outages = useAuthOutageStore.getState().outages;
			expect(Object.keys(outages).sort()).toEqual(['claude-code', 'codex']);
		});
		// Cue spawns its agents outside the ProcessManager, so a pipeline auth
		// failure arrives on its own channel - and that is the case where a silent
		// failure costs the most.
		it('folds a pipeline auth failure into the same provider outage', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
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
			s4_useSessionStore.setState({ sessions: [] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			authExpiredHandler!({
				sessionId: 'deleted',
				agentId: 'claude-code',
				message: 'OAuth token has expired.',
			});
			expect(useModalStore.getState().modals.get('reauth')?.open ?? false).toBe(false);
		});
		it('clears stale agentSessionId on session_not_found', () => {
			const tab = s4_createMockAITab({ id: 'tab-1', agentSessionId: 'old-id' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });
			const updated = s4_useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentSessionId).toBeNull();
			// Modal should NOT open for session_not_found
			const entry = useModalStore.getState().modals.get('agentError');
			expect(entry?.open ?? false).toBe(false);
		});
		it('stamps recoveryAction with the last user prompt on session_not_found', () => {
			const userLog = {
				id: 'log-user',
				timestamp: 100,
				source: 'user' as const,
				text: 'do the thing that died',
			};
			const tab = s4_createMockAITab({
				id: 'tab-1',
				agentSessionId: 'old-id',
				logs: [userLog],
			});
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });
			const tabAfter = s4_useSessionStore.getState().sessions[0].aiTabs[0];
			const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
			expect(systemEntry?.recoveryAction).toEqual({
				lastUserPrompt: 'do the thing that died',
				tabId: 'tab-1',
			});
		});
		it('omits recoveryAction when no user message exists yet', () => {
			const tab = s4_createMockAITab({ id: 'tab-1', agentSessionId: 'old-id', logs: [] });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'session_not_found' });
			const tabAfter = s4_useSessionStore.getState().sessions[0].aiTabs[0];
			const systemEntry = tabAfter.logs.find((l) => l.source === 'system');
			expect(systemEntry?.recoveryAction).toBeUndefined();
		});
		it('appends an error log entry to the targeted tab', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', baseError);
			const tabAfter = s4_useSessionStore.getState().sessions[0].aiTabs[0];
			const errorLog = tabAfter.logs.find((l) => l.source === 'error');
			expect(errorLog).toBeDefined();
			expect(errorLog?.text).toBe('expired');
		});
		it('tags the error log with renderStyle=text-stream when the session is interactive', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
			} as any);
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', baseError);
			const tabAfter = s4_useSessionStore.getState().sessions[0].aiTabs[0];
			const errorLog = tabAfter.logs.find((l) => l.source === 'error');
			expect(errorLog?.renderStyle).toBe('text-stream');
		});
		it('leaves renderStyle unset on API-mode (non-interactive) errors', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				claudeInteractive: { mode: 'api', modeReason: 'auto' },
			} as any);
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', baseError);
			const tabAfter = s4_useSessionStore.getState().sessions[0].aiTabs[0];
			const errorLog = tabAfter.logs.find((l) => l.source === 'error');
			expect(errorLog?.renderStyle).toBeUndefined();
		});
		it('deletes the activeHiddenToolRef entry on error', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			const deps = makeDeps();
			deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });
			s4_renderHook(() => useAgentErrorListener(deps));
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
			const tab = s4_createMockAITab({ id: 'tab-1', logs: [userLog] });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'rate_limited', message: 'usage limit' });
			// Synchronous pause: error stamped, paused, retry counter seeded to 0.
			const paused = s4_useSessionStore.getState().sessions[0];
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
				expect(s4_useSessionStore.getState().sessions[0].agentError?.limitResetAt).toBe(
					1700000123456
				);
			});
		});
		it('does not stamp a local reset estimate on an SSH-backed session', async () => {
			const getLimitResetAt = vi.fn().mockResolvedValue(1700000123456);
			(window as any).maestro.agents = { getLimitResetAt };
			const tab = s4_createMockAITab({ id: 'tab-1' });
			// SSH-backed: the local usage snapshot reflects the wrong account, so the
			// estimate must be skipped and the session left to the interval fallback.
			const session = s4_createMockSession({
				id: 'sess-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				sshRemoteId: 'remote-1',
			});
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', { ...baseError, type: 'rate_limited', message: 'usage limit' });
			// Still pauses synchronously; only the local reset probe is skipped.
			const paused = s4_useSessionStore.getState().sessions[0];
			expect(paused.agentErrorPaused).toBe(true);
			expect(getLimitResetAt).not.toHaveBeenCalled();
			expect(paused.agentError?.limitResetAt).toBeUndefined();
		});
		it('auto-retries a recoverable overload error and suppresses the modal', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			// A prompt must have been dispatched so there's something to resend.
			seedSnapshot('sess-1', 'tab-1');
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', overloadError);
			// No blocking error state / modal - the retry engine owns it.
			const updated = s4_useSessionStore.getState().sessions[0];
			expect(updated.state).not.toBe('error');
			expect(updated.agentError).toBeUndefined();
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
			// A retry was scheduled with the availability strategy.
			const entry = s4_useRetryStore.getState().retries['sess-1:tab-1'];
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
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			seedSnapshot('sess-1', 'tab-1');
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			// First failure → one marker appended.
			handler!('sess-1-ai-tab-1', overloadError);
			const outageId = s4_useRetryStore.getState().retries['sess-1:tab-1']?.outageId;
			// A second failure for the same outage (the resend failed again) must NOT
			// append another transcript entry - the live card already covers it.
			handler!('sess-1-ai-tab-1', overloadError);
			const logs = s4_useSessionStore.getState().sessions[0].aiTabs[0].logs;
			const markers = logs.filter((l) => l.retryOutageId);
			expect(markers).toHaveLength(1);
			expect(markers[0].retryOutageId).toBe(outageId);
			cancelRetry('sess-1', 'tab-1');
		});
		it('auto-continues an Auto Run batch (resumes instead of pausing for the user)', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
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
			s4_renderHook(() => useAgentErrorListener(deps));
			handler!('sess-1-ai-tab-1', overloadError);
			// The batch was parked (so the loop can be resumed) but the modal stays shut.
			expect(pauseBatchOnError).toHaveBeenCalled();
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
			// A batch-resume retry was scheduled (no prompt snapshot needed).
			const entry = s4_useRetryStore.getState().retries['sess-1:tab-1'];
			expect(entry?.mode).toBe('batch-resume');
			expect(entry?.strategy).toBe('availability');
			cancelRetry('sess-1', 'tab-1');
			registerBatchResumer(null);
		});
		it('falls back to the error modal when there is no prompt to resend', () => {
			const tab = s4_createMockAITab({ id: 'tab-2' });
			const session = s4_createMockSession({ id: 'sess-2', aiTabs: [tab], activeTabId: 'tab-2' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			// No seedSnapshot → nothing captured → cannot auto-retry.
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-2-ai-tab-2', overloadError);
			const updated = s4_useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('error');
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(true);
			expect(s4_useRetryStore.getState().retries['sess-2:tab-2']).toBeUndefined();
		});
		// An Auto Run task process owns no AI tab. Before this guard the tab fallback
		// resolved to getActiveTab(), so killing an Auto Run painted the batch's error
		// into the user's unrelated chat tab and flipped the whole agent to `error`.
		it('leaves the active chat tab alone when a running Auto Run errors', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
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
			s4_renderHook(() => useAgentErrorListener(deps));
			handler!('sess-1-batch-1700000000000', { ...baseError, type: 'agent_crashed' });
			const updated = s4_useSessionStore.getState().sessions[0];
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
			const tab = s4_createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			// No batch state registered: the straggler path still must not touch the tab.
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-batch-1700000000000', { ...baseError, type: 'session_not_found' });
			const updated = s4_useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentSessionId).toBe('claude-abc');
			expect(updated.aiTabs[0].logs).toHaveLength(tab.logs.length);
		});
		// A full context window is fixed by compacting the session and resending, so
		// the failure itself must leave no mark: no error frame, no ERR badge, no
		// modal, no outage card. The compaction pill is the whole record.
		it('masks a context-limit error behind a compaction pill', () => {
			registerContextCompactionSpawner(vi.fn(() => new Promise(() => {})));
			const tab = s4_createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
			const session = s4_createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			s4_useSessionStore.setState({ sessions: [session] } as any);
			seedSnapshot('sess-1', 'tab-1');
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', contextLimitError);
			const updated = s4_useSessionStore.getState().sessions[0];
			expect(updated.state).not.toBe('error');
			expect(updated.agentError).toBeUndefined();
			expect(updated.aiTabs[0].agentError).toBeUndefined();
			expect(useModalStore.getState().modals.get('agentError')?.open ?? false).toBe(false);
			const added = updated.aiTabs[0].logs.slice(tab.logs.length);
			expect(added).toHaveLength(1);
			expect(added[0].contextCompaction).toEqual({ status: 'pending' });
			expect(added[0].retryOutageId).toBeUndefined();
			expect(s4_useRetryStore.getState().retries['sess-1:tab-1']?.strategy).toBe(
				'context-compaction'
			);
			expect(s4_useRetryStore.getState().outages).toEqual({});
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
						new Promise<{
							success: boolean;
							error?: string;
						}>((resolve) => {
							failCompaction = resolve;
						})
				)
			);
			const tab = s4_createMockAITab({ id: 'tab-1', agentSessionId: 'claude-abc' });
			const session = s4_createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			s4_useSessionStore.setState({ sessions: [session] } as any);
			seedSnapshot('sess-1', 'tab-1');
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-ai-tab-1', contextLimitError);
			noteFailedTurnExited('sess-1', 'tab-1');
			failCompaction({ success: false, error: 'Prompt is too long' });
			await waitFor(() => {
				expect(s4_useSessionStore.getState().sessions[0].state).toBe('error');
			});
			const updated = s4_useSessionStore.getState().sessions[0];
			expect(updated.agentError?.type).toBe('token_exhaustion');
			expect(updated.aiTabs[0].logs.some((l) => l.source === 'error')).toBe(true);
			expect(updated.aiTabs[0].logs.find((l) => l.contextCompaction)?.contextCompaction).toEqual({
				status: 'error',
				error: 'Prompt is too long',
			});
			expect(useModalStore.getState().modals.get('agentError')?.open).toBe(true);
			expect(s4_useRetryStore.getState().retries['sess-1:tab-1']).toBeUndefined();
			registerContextCompactionSpawner(null);
		});
		it('skips synopsis-process errors', () => {
			const tab = s4_createMockAITab({ id: 'tab-1' });
			const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab] });
			s4_useSessionStore.setState({ sessions: [session] } as any);
			s4_renderHook(() => useAgentErrorListener(makeDeps()));
			handler!('sess-1-synopsis', baseError);
			expect(s4_useSessionStore.getState().sessions[0].state).not.toBe('error');
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
				s4_renderHook(() => useAgentErrorListener(makeDeps()));
				handler!('tab-naming-abc', effortRefusal);
				expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
				const toasts = useNotificationStore.getState().toasts;
				expect(toasts).toHaveLength(1);
				expect(toasts[0].title).toBe('Codex rejected effort "low"');
			});
			it('notes a refusal from a synopsis, which returns before any other handling', () => {
				s4_renderHook(() => useAgentErrorListener(makeDeps()));
				handler!('sess-1-synopsis-1700000000000', effortRefusal);
				expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
			});
			it('leaves a running Auto Run alone when its task is armed to retry itself', () => {
				const tab = s4_createMockAITab({ id: 'tab-1' });
				const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
				s4_useSessionStore.setState({ sessions: [session] } as any);
				const pauseBatchOnError = vi.fn();
				armEffortFallback('sess-1-batch-1700000000000');
				s4_renderHook(() => useAgentErrorListener(runningBatchDeps(pauseBatchOnError)));
				handler!('sess-1-batch-1700000000000', effortRefusal);
				// Parking the run behind an error banner for a task that is about to be
				// re-run would stop the run the retry is trying to save.
				expect(pauseBatchOnError).not.toHaveBeenCalled();
				expect(s4_useSessionStore.getState().sessions[0].state).not.toBe('error');
				// The refusal is held for the spawn's exit handler to collect.
				expect(settleEffortFallback('sess-1-batch-1700000000000')?.value).toBe('low');
			});
			it('still parks the Auto Run when the task is not armed', () => {
				// No effort override was sent, so nothing will retry: the refusal is of
				// the agent's own setting and the user has to see it.
				const tab = s4_createMockAITab({ id: 'tab-1' });
				const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
				s4_useSessionStore.setState({ sessions: [session] } as any);
				const pauseBatchOnError = vi.fn();
				s4_renderHook(() => useAgentErrorListener(runningBatchDeps(pauseBatchOnError)));
				handler!('sess-1-batch-1700000000001', effortRefusal);
				expect(pauseBatchOnError).toHaveBeenCalled();
			});
			it('still surfaces the refusal on an ordinary tab turn', () => {
				// The user picked this effort on the tab. Their turn fails with the
				// provider's own message; nothing here rewrites their choice.
				const tab = s4_createMockAITab({ id: 'tab-1' });
				const session = s4_createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
				s4_useSessionStore.setState({ sessions: [session] } as any);
				s4_renderHook(() => useAgentErrorListener(makeDeps()));
				handler!('sess-1-ai-tab-1', effortRefusal);
				const updated = s4_useSessionStore.getState().sessions[0];
				expect(updated.state).toBe('error');
				expect(updated.aiTabs[0].agentError?.message).toContain('Unsupported value');
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentSessionIdListener.test.tsx
describe('', () => {
	let handler: ((sessionId: string, agentSessionId: string) => Promise<void>) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onSessionId: vi.fn((h: any) => {
			handler = h;
			return mockUnsubscribe;
		}),
	};
	function makeBatched(): S5_BatchedUpdater {
		return {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
		};
	}
	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		s5_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = {
			...((window as any).maestro || {}),
			process: mockProcess,
			agentSessions: { registerSessionOrigin: vi.fn().mockResolvedValue(undefined) },
		};
	});
	describe('useAgentSessionIdListener', () => {
		it('captures agent session id on the targeted tab', async () => {
			const tab = s5_createMockAITab({ id: 'tab-1', awaitingSessionId: true });
			const session = s5_createMockSession({
				id: 'sess-1',
				toolType: 'codex',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			s5_useSessionStore.setState({ sessions: [session] } as any);
			s5_renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
			await handler!('sess-1-ai-tab-1', 'agent-uuid-1');
			const updated = s5_useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
			expect(updated.aiTabs[0].awaitingSessionId).toBe(false);
			// Non-claude-code: session-level id is also stamped.
			expect(updated.agentSessionId).toBe('agent-uuid-1');
		});
		it('skips session-level id for claude-code (treats fork ids as throwaway)', async () => {
			const tab = s5_createMockAITab({ id: 'tab-1', awaitingSessionId: true });
			const session = s5_createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			s5_useSessionStore.setState({ sessions: [session] } as any);
			s5_renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
			await handler!('sess-1-ai-tab-1', 'agent-uuid-1');
			const updated = s5_useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
			expect(updated.agentSessionId).toBeUndefined();
		});
		it('detects resume failure when ID changes on non-claude-code', async () => {
			const tab = s5_createMockAITab({
				id: 'tab-1',
				agentSessionId: 'old-id',
				awaitingSessionId: true,
			});
			const session = s5_createMockSession({
				id: 'sess-1',
				toolType: 'codex',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			s5_useSessionStore.setState({ sessions: [session] } as any);
			const batched = makeBatched();
			s5_renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			await handler!('sess-1-ai-tab-1', 'new-id');
			// Resume failure → context gauge zeroed
			expect(batched.updateContextUsage).toHaveBeenCalledWith('sess-1', 0);
			const updated = s5_useSessionStore.getState().sessions[0];
			const log = updated.aiTabs[0].logs.find((l) => l.text.includes('resume failed'));
			expect(log).toBeDefined();
		});
		it('keeps original id on claude-code mismatch (silent fork)', async () => {
			const tab = s5_createMockAITab({
				id: 'tab-1',
				agentSessionId: 'old-id',
				awaitingSessionId: true,
			});
			const session = s5_createMockSession({
				id: 'sess-1',
				toolType: 'claude-code',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			s5_useSessionStore.setState({ sessions: [session] } as any);
			const batched = makeBatched();
			s5_renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			await handler!('sess-1-ai-tab-1', 'fork-id');
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(s5_useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBe('old-id');
		});
		it('ignores batch session ids', async () => {
			const session = s5_createMockSession({ id: 'sess-1' });
			s5_useSessionStore.setState({ sessions: [session] } as any);
			s5_renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
			await handler!('sess-1-batch-tab-1', 'agent-uuid-1');
			expect(s5_useSessionStore.getState().sessions[0].agentSessionId).toBeUndefined();
		});
		it('skips no-op render when session is missing', async () => {
			const setSessionsSpy = vi.spyOn(s5_useSessionStore.getState(), 'setSessions');
			s5_renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
			await handler!('missing-ai-tab-1', 'agent-uuid-1');
			// No session found - nothing to update, so the store setter is never invoked at all.
			expect(setSessionsSpy).not.toHaveBeenCalled();
			const sessions = s5_useSessionStore.getState().sessions;
			expect(sessions).toEqual([]);
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentSlashCommandsListener.test.tsx
describe('', () => {
	let onSlashCommandsHandler: ((sessionId: string, slashCommands: string[]) => void) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onSlashCommands: vi.fn((handler: any) => {
			onSlashCommandsHandler = handler;
			return mockUnsubscribe;
		}),
	};
	beforeEach(() => {
		vi.clearAllMocks();
		onSlashCommandsHandler = undefined;
		s6_useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});
	describe('useAgentSlashCommandsListener', () => {
		it('registers exactly one listener on mount and unsubscribes on unmount', () => {
			const { unmount } = s6_renderHook(() => useAgentSlashCommandsListener());
			expect(mockProcess.onSlashCommands).toHaveBeenCalledTimes(1);
			unmount();
			expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
		});
		it('writes normalised commands to the matching session', () => {
			const session = s6_createMockSession({ id: 'sess-1', toolType: 'claude-code' });
			s6_useSessionStore.setState({ sessions: [session] } as any);
			s6_renderHook(() => useAgentSlashCommandsListener());
			onSlashCommandsHandler!('sess-1', ['help', '/clear', 'config']);
			const updated = s6_useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentCommands?.map((c) => c.command)).toEqual(['/help', '/clear', '/config']);
			updated?.agentCommands?.forEach((c) => {
				expect(c.description).toBeDefined();
			});
		});
		it('skips no-op renders when the session does not exist (orphan event)', () => {
			const setSessionsSpy = vi.spyOn(s6_useSessionStore.getState(), 'setSessions');
			s6_renderHook(() => useAgentSlashCommandsListener());
			onSlashCommandsHandler!('missing-session', ['/help']);
			expect(setSessionsSpy).not.toHaveBeenCalled();
		});
		it('handles empty command arrays', () => {
			const session = s6_createMockSession({ id: 'sess-1' });
			s6_useSessionStore.setState({ sessions: [session] } as any);
			s6_renderHook(() => useAgentSlashCommandsListener());
			onSlashCommandsHandler!('sess-1', []);
			const updated = s6_useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
			expect(updated?.agentCommands).toEqual([]);
		});
	});
});
// Source: src/__tests__/renderer/hooks/agent/internal/useAgentStderrListener.test.tsx
describe('', () => {
	let onStderrHandler: ((sessionId: string, data: string) => void) | undefined;
	const mockUnsubscribe = vi.fn();
	const mockProcess = {
		onStderr: vi.fn((handler: any) => {
			onStderrHandler = handler;
			return mockUnsubscribe;
		}),
	};
	function makeBatched(): S7_BatchedUpdater {
		return {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
		};
	}
	beforeEach(() => {
		vi.clearAllMocks();
		onStderrHandler = undefined;
		(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	});
	describe('useAgentStderrListener', () => {
		it('subscribes once and unsubscribes on unmount', () => {
			const { unmount } = s7_renderHook(() =>
				useAgentStderrListener({ batchedUpdater: makeBatched() })
			);
			expect(mockProcess.onStderr).toHaveBeenCalledTimes(1);
			unmount();
			expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
		});
		it('routes ai-tab-format stderr to the AI tab with isStderr=true', () => {
			const batched = makeBatched();
			s7_renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1-ai-tab-1', 'oh no\n');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'oh no\n', true);
		});
		it('routes plain session ids to the terminal log with isStderr=true', () => {
			const batched = makeBatched();
			s7_renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1', 'oops');
			expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'oops', true);
		});
		it('drops empty/whitespace-only stderr', () => {
			const batched = makeBatched();
			s7_renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1', '   ');
			onStderrHandler!('sess-1', '\n\t');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});
		it('ignores batch session ids', () => {
			const batched = makeBatched();
			s7_renderHook(() => useAgentStderrListener({ batchedUpdater: batched }));
			onStderrHandler!('sess-1-batch-tab-1', 'data');
			expect(batched.appendLog).not.toHaveBeenCalled();
		});
	});
});
