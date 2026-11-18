import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentSessionIdListener } from '../../../../../renderer/hooks/agent/internal/useAgentSessionIdListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';
import { resetStores } from '../../../../helpers/resetStores';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { Session } from '../../../../../renderer/types';
import type { ProcessSpawnAttempt } from '../../../../../main/preload/process/core';
import type { NativeSessionLaunch } from '../../../../../main/process-manager/types';
import { switchTabProvider } from '../../../../../renderer/utils/providerTabSessions';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';

let handler:
	| ((sessionId: string, agentSessionId: string, launch?: NativeSessionLaunch) => Promise<void>)
	| undefined;
let attemptHandler: ((attempt: ProcessSpawnAttempt) => void) | undefined;
const mockAttemptUnsubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onSpawnAttempt: vi.fn((h: (attempt: ProcessSpawnAttempt) => void) => {
		attemptHandler = h;
		return mockAttemptUnsubscribe;
	}),
	onSessionId: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

// Captured host provenance, deliberately independent of mutable renderer settings.
const nativeScope = {
	version: 1,
	state: 'bound',
	provider: 'grok',
	accountRef: 'account-a',
	host: { kind: 'ssh', identity: 'endpoint-a' },
	cwd: '/remote/project',
} as const;
const nativeBinding = { ...nativeScope, nativeSessionId: 'native-observed' };

function announceNativeAttempt(overrides: Partial<ProcessSpawnAttempt> = {}): NativeSessionLaunch {
	const attempt: ProcessSpawnAttempt = {
		sessionId: 'sess-1-ai-target',
		toolType: 'grok',
		nativeSessionRequestId: 'request-1',
		...overrides,
	};
	// Omitted config.tabId is normal for existing raw ai-tab callers.
	act(() => attemptHandler!(attempt));
	return {
		scope: nativeScope,
		tabId: overrides.tabId ?? 'target',
		processGeneration: 7,
		nativeSessionRequestId: attempt.nativeSessionRequestId,
		requestedNativeSessionId: attempt.requestedNativeSessionId,
	};
}

function makeBatched(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
		flushNow: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	attemptHandler = undefined;
	resetStores(useSessionStore, useNotificationStore);
	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: { ...mockProcess },
		agentSessions: { registerSessionOrigin: vi.fn().mockResolvedValue(undefined) },
	};
});

afterEach(() => vi.restoreAllMocks());

describe('useAgentSessionIdListener', () => {
	it('captures agent session id on the targeted tab', async () => {
		const tab = createMockAITab({ id: 'tab-1', awaitingSessionId: true });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('sess-1-ai-tab-1', 'agent-uuid-1');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
		expect(updated.aiTabs[0].awaitingSessionId).toBe(false);
		// Non-claude-code: session-level id is also stamped.
		expect(updated.agentSessionId).toBe('agent-uuid-1');
	});

	it('skips session-level id for claude-code (treats fork ids as throwaway)', async () => {
		const tab = createMockAITab({ id: 'tab-1', awaitingSessionId: true });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('sess-1-ai-tab-1', 'agent-uuid-1');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
		expect(updated.agentSessionId).toBeUndefined();
	});

	it('detects resume failure when ID changes on non-claude-code', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handler!('sess-1-ai-tab-1', 'new-id');

		// Resume failure → context gauge zeroed
		expect(batched.updateContextUsage).toHaveBeenCalledWith('sess-1', 0);
		const updated = useSessionStore.getState().sessions[0];
		const log = updated.aiTabs[0].logs.find((l) => l.text.includes('resume failed'));
		expect(log).toBeDefined();
	});

	it('keeps original id on claude-code mismatch (silent fork)', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handler!('sess-1-ai-tab-1', 'fork-id');

		expect(batched.updateContextUsage).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBe('old-id');
	});

	it('ignores batch session ids', async () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('sess-1-batch-tab-1', 'agent-uuid-1');

		expect(useSessionStore.getState().sessions[0].agentSessionId).toBeUndefined();
	});

	it('skips no-op render when session is missing', async () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('missing-ai-tab-1', 'agent-uuid-1');
		// No session found - nothing to update, so the store setter is never invoked at all.
		expect(setSessionsSpy).not.toHaveBeenCalled();
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toEqual([]);
	});

	describe('Grok native identity retention', () => {
		// Both transports deliver the same renderer event; this does not certify ACP routing.
		it.each([
			{ phase: 'native end-only', settled: true, delivered: true },
			{ phase: 'ACP announced allocation', settled: false, delivered: true },
			{ phase: 'confirmed allocation after cancellation', settled: true, delivered: true },
			{ phase: 'cancelled turn with no ID event', settled: true, delivered: false },
		])('retains only observed IDs: $phase', async ({ settled, delivered }) => {
			const tab = createMockAITab({
				id: 'target',
				name: 'New Session',
				turnProvider: 'grok',
				state: 'busy',
				awaitingSessionId: true,
			});
			const active = createMockAITab({ id: 'active', awaitingSessionId: true });
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'grok',
				state: 'busy',
				aiTabs: [tab, active],
				activeTabId: active.id,
			});
			useSessionStore.setState({ sessions: [session] });
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			const launch = announceNativeAttempt();
			const captured = useSessionStore.getState().sessions[0];
			expect(captured.aiTabs[0].agentSessionId).toBeNull();
			await act(async () => {
				if (settled)
					useSessionStore.setState({
						sessions: [
							{
								...captured,
								state: 'idle',
								aiTabs: [{ ...captured.aiTabs[0], state: 'idle' }, active],
							},
						],
					});
				if (delivered) await handler!('sess-1-ai-target', 'native-observed', launch);
			});
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0]).toMatchObject({
				agentSessionId: delivered ? 'native-observed' : null,
				awaitingSessionId: !delivered,
				name: delivered ? null : 'New Session',
				state: settled ? 'idle' : 'busy',
			});
			expect(updated.aiTabs[0].nativeSessionBinding).toEqual(delivered ? nativeBinding : undefined);
			expect(updated.aiTabs[1]).toBe(active);
			expect(updated.activeTabId).toBe(active.id);
			expect(updated.agentSessionId).toBeUndefined();
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each([
			['legacy tabless target', 'sess-1-ai', 'native-observed'],
			['bare agent target', 'sess-1', 'native-observed'],
			['missing tab', 'sess-1-ai-missing', 'native-observed'],
			['closed tab', 'sess-1-ai-closed', 'native-observed'],
			['empty ID', 'sess-1-ai-active', ''],
			['whitespace ID', 'sess-1-ai-active', ' \t\n'],
		])('ignores %s without assigning an active/session fallback', async (kind, target, id) => {
			const active = createMockAITab({ id: 'active', awaitingSessionId: true });
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'grok',
				aiTabs: [active],
				activeTabId: active.id,
			});
			useSessionStore.setState({
				sessions: [
					{
						...session,
						aiTabs: [active, ...(kind === 'closed tab' ? [createMockAITab({ id: 'closed' })] : [])],
					},
				],
			});
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			await act(async () => {
				useSessionStore.setState({ sessions: [session] });
				await handler!(target, id);
			});
			expect(useSessionStore.getState().sessions[0]).toBe(session);
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each(
			[false, true].flatMap((parked) =>
				['retained', 'requested'].map((mismatch) => ({ parked, mismatch }))
			)
		)(
			'rejects a $mismatch ID mismatch without losing evidence (parked=$parked)',
			async ({ parked, mismatch }) => {
				const usage = {
					inputTokens: 120,
					outputTokens: 30,
					cacheReadInputTokens: 40,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.25,
					contextWindow: 1000,
				};
				const tab = createMockAITab({
					id: 'target',
					turnProvider: 'grok',
					awaitingSessionId: true,
					agentSessionId: parked ? 'incoming-native' : 'original-native',
					nativeSessionBinding: parked
						? undefined
						: { ...nativeBinding, nativeSessionId: 'original-native' },
					usageStats: usage,
					pendingMergedContext: 'retained context',
					logs: [{ id: 'history', timestamp: 1, source: 'user', text: 'original history' }],
					providerSessions: parked
						? {
								grok: {
									agentSessionId: 'original-native',
									nativeSessionBinding: { ...nativeBinding, nativeSessionId: 'original-native' },
									usageStats: usage,
									customModel: 'grok-model',
								},
							}
						: undefined,
				});
				const active = createMockAITab({ id: 'active', agentSessionId: 'other-native' });
				const session = createMockSession({
					id: 'sess-1',
					toolType: parked ? 'codex' : 'grok',
					state: 'busy',
					agentSessionId: 'session-retained',
					contextUsage: 63,
					aiTabs: [tab, active],
					activeTabId: active.id,
				});
				useSessionStore.setState({ sessions: [session] });
				const batched = makeBatched();
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
				const launch = announceNativeAttempt({ requestedNativeSessionId: 'replacement-native' });
				await act(async () => {
					await handler!(
						'sess-1-ai-target',
						mismatch === 'requested' ? 'original-native' : 'replacement-native',
						launch
					);
				});
				const updated = useSessionStore.getState().sessions[0];
				const target = updated.aiTabs[0];
				expect(target.agentSessionId).toBe(tab.agentSessionId);
				expect(target.providerSessions).toEqual(tab.providerSessions);
				expect(target.nativeSessionBinding).toEqual(tab.nativeSessionBinding);
				expect(target.usageStats).toEqual(usage);
				expect(target.pendingMergedContext).toBe(tab.pendingMergedContext);
				expect(target.logs.slice(0, -1)).toEqual(tab.logs);
				expect(target.logs).toHaveLength(2);
				expect(target.logs[1]).toMatchObject({
					source: 'error',
					agentError: {
						type: 'session_not_found',
						agentId: 'grok',
						recoverable: false,
						sessionId: 'sess-1-ai-target',
						message: expect.stringContaining('original session ID and history were retained'),
					},
				});
				expect(updated.aiTabs[1]).toBe(active);
				expect(updated.activeTabId).toBe(active.id);
				expect(updated.agentSessionId).toBe('session-retained');
				expect(updated.contextUsage).toBe(63);
				expect(updated.state).toBe(parked ? 'busy' : 'error');
				expect(updated.agentError).toEqual(parked ? undefined : target.logs[1].agentError);
				expect(updated.agentErrorTabId).toBe(parked ? undefined : tab.id);
				expect(updated.agentErrorPaused).toBe(parked ? undefined : true);
				expect(target.agentError).toEqual(parked ? undefined : target.logs[1].agentError);
				expect(target.awaitingSessionId).toBe(parked);
				expect(batched.updateContextUsage).not.toHaveBeenCalled();
				expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
				expect(useNotificationStore.getState().toasts).toEqual([
					expect.objectContaining({
						color: 'yellow',
						title: 'Grok Session Resume Failed',
						sessionId: 'sess-1',
						message: expect.stringContaining('original session ID and history were retained'),
					}),
				]);
			}
		);

		it('accepts a matching ID again without renaming the retained conversation', async () => {
			const tab = createMockAITab({
				id: 'target',
				name: 'My Grok history',
				agentSessionId: 'native-observed',
				nativeSessionBinding: nativeBinding,
				turnProvider: 'grok',
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'grok',
				aiTabs: [tab],
				activeTabId: tab.id,
			});
			useSessionStore.setState({ sessions: [session] });
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
			const captured = useSessionStore.getState().sessions[0];
			await act(async () => {
				await handler!('sess-1-ai-target', 'native-observed', launch);
				await handler!('sess-1-ai-target', 'native-observed', launch);
			});
			expect(useSessionStore.getState().sessions[0]).toEqual({
				...captured,
				aiTabs: [{ ...captured.aiTabs[0], awaitingSessionId: false }],
			});
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each([null, 'native-observed'])(
			'parks an observed ID after a switch (retained=%s)',
			async (retained) => {
				const tab = createMockAITab({
					id: 'target',
					turnProvider: 'grok',
					agentSessionId: 'incoming-native',
					name: 'Incoming conversation',
					awaitingSessionId: true,
					providerSessions: {
						grok: {
							agentSessionId: retained,
							customModel: 'grok-model',
							nativeSessionBinding: retained ? nativeBinding : undefined,
						},
					},
				});
				const session = createMockSession({
					id: 'sess-1',
					toolType: 'codex',
					state: 'busy',
					aiTabs: [tab],
					activeTabId: tab.id,
					agentSessionId: 'incoming-session',
					contextUsage: 63,
				});
				useSessionStore.setState({ sessions: [session] });
				const batched = makeBatched();
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
				const launch = announceNativeAttempt({ requestedNativeSessionId: retained ?? undefined });
				const captured = useSessionStore.getState().sessions[0];
				await act(async () => {
					await handler!('sess-1-ai-target', 'native-observed', launch);
				});
				expect(useSessionStore.getState().sessions[0]).toEqual({
					...captured,
					aiTabs: [
						{
							...captured.aiTabs[0],
							providerSessions: {
								grok: {
									agentSessionId: 'native-observed',
									customModel: 'grok-model',
									nativeSessionBinding: nativeBinding,
								},
							},
						},
					],
				});
				expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
				expect(batched.updateContextUsage).not.toHaveBeenCalled();
				expect(useNotificationStore.getState().toasts).toEqual([]);
			}
		);
	});
	describe('Grok launch ownership', () => {
		beforeEach(() => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						id: 'sess-1',
						toolType: 'grok',
						activeTabId: 'target',
						aiTabs: [
							createMockAITab({
								id: 'target',
								turnProvider: 'grok',
								agentSessionId: 'native-observed',
								nativeSessionBinding: nativeBinding,
								awaitingSessionId: true,
								logs: [{ id: 'history', timestamp: 1, source: 'user', text: 'retained history' }],
							}),
						],
					}),
				],
			});
		});

		it.each([
			['missing receipt', null],
			['unknown legacy scope', { scope: { version: 1, state: 'unknown', reason: 'legacy' } }],
			[
				'unknown unobserved scope',
				{ scope: { version: 1, state: 'unknown', reason: 'unobserved' } },
			],
			['missing scope', { scope: undefined }],
			['wrong request token', { nativeSessionRequestId: 'obsolete-request' }],
			['missing request token', { nativeSessionRequestId: undefined }],
			['wrong tab', { tabId: 'other' }],
			['missing tab', { tabId: undefined }],
			['wrong requested ID', { requestedNativeSessionId: 'different' }],
			...[undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7'].map(
				(value) => [`invalid generation ${value}`, { processGeneration: value }] as const
			),
			...[
				{ version: 2 },
				{ provider: 'codex' },
				{ accountRef: '' },
				{ cwd: 'bad\0cwd' },
				{ host: { kind: 'local' } },
				{ host: { kind: 'other', identity: 'endpoint-a' } },
				{ accountRef: 'account-b' },
				{ host: { kind: 'ssh', identity: 'endpoint-b' } },
				{ cwd: '/remote/other' },
			].map(
				(scope, index) =>
					[`invalid or changed scope ${index}`, { scope: { ...nativeScope, ...scope } }] as const
			),
		] as const)('preserves ownership and history for %s', async (_label, patch) => {
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
			const captured = useSessionStore.getState().sessions[0];
			await act(async () =>
				handler!(
					'sess-1-ai-target',
					'native-observed',
					patch === null ? undefined : ({ ...launch, ...patch } as NativeSessionLaunch)
				)
			);
			expect(useSessionStore.getState().sessions[0]).toBe(captured);
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each([undefined, 'legacy', 'unobserved'] as const)(
			'never promotes retained %s ownership using matching IDs/settings',
			async (reason) => {
				useSessionStore.setState(({ sessions }) => ({
					sessions: sessions.map((s) => ({
						...s,
						cwd: nativeScope.cwd,
						projectRoot: nativeScope.cwd,
						customEnvVars: { GROK_HOME: '/remote/account-a' },
						aiTabs: s.aiTabs.map((tab) => ({
							...tab,
							nativeSessionBinding: reason ? { version: 1, state: 'unknown', reason } : undefined,
						})),
					})),
				}));
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
				const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
				const captured = useSessionStore.getState().sessions[0];
				await act(async () => handler!('sess-1-ai-target', 'native-observed', launch));
				expect(useSessionStore.getState().sessions[0]).toBe(captured);
			}
		);

		it.each(['', ' \t\n', 'bad\0id'])(
			'rejects invalid observed ID %j with a valid receipt',
			async (id) => {
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
				const launch = announceNativeAttempt();
				const captured = useSessionStore.getState().sessions[0];
				await act(async () => handler!('sess-1-ai-target', id, launch));
				expect(useSessionStore.getState().sessions[0]).toBe(captured);
				expect(useNotificationStore.getState().toasts).toEqual([]);
			}
		);

		it.each([
			['removed owner', () => undefined],
			['reconstructed owner', (s: Session) => structuredClone(s)],
			['owner creation changed', (s: Session) => ({ ...s, createdAt: (s.createdAt ?? 0) + 1 })],
			['removed tab', (s: Session) => ({ ...s, aiTabs: [] })],
			[
				'replaced same-ID tab',
				(s: Session) => ({ ...s, aiTabs: s.aiTabs.map((t) => structuredClone(t)) }),
			],
			[
				'tab creation changed',
				(s: Session) => ({
					...s,
					aiTabs: s.aiTabs.map((t) => ({ ...t, createdAt: t.createdAt + 1 })),
				}),
			],
			[
				'changed turn owner',
				(s: Session) => ({
					...s,
					aiTabs: s.aiTabs.map((t) => ({ ...t, turnProvider: 'codex' as const })),
				}),
			],
			[
				'changed native ID',
				(s: Session) => ({
					...s,
					aiTabs: s.aiTabs.map((t) => ({ ...t, agentSessionId: 'other' })),
				}),
			],
			[
				'replaced binding',
				(s: Session) => ({
					...s,
					aiTabs: s.aiTabs.map((t) => ({ ...t, nativeSessionBinding: { ...nativeBinding } })),
				}),
			],
		] as const)(
			'invalidates %s even if the original snapshot is restored',
			async (_label, change) => {
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
				const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
				const captured = useSessionStore.getState().sessions[0];
				await act(async () => {
					const changed = change(captured);
					useSessionStore.setState({ sessions: changed ? [changed] : [] });
					useSessionStore.setState({ sessions: [captured] });
					await handler!('sess-1-ai-target', 'native-observed', launch);
				});
				expect(useSessionStore.getState().sessions[0]).toBe(captured);
				expect(useNotificationStore.getState().toasts).toEqual([]);
			}
		);

		it.each([
			['Grok successor', {}],
			['failed non-Grok successor', { toolType: 'codex' }],
			['forced parallel', { sessionId: 'sess-1-ai-target-fp-123' }],
			['tab-mismatched successor', { tabId: 'other' }],
			['legacy successor', { sessionId: 'sess-1-ai' }],
			['bare successor', { sessionId: 'sess-1' }],
		])(
			'rejects a queued prior-generation ID before %s announces any ID',
			async (_label, successor) => {
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
				const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
				const next = {
					...announceNativeAttempt({ nativeSessionRequestId: 'request-2', ...successor }),
					processGeneration: 8,
				};
				const captured = useSessionStore.getState().sessions[0];
				await act(async () => handler!('sess-1-ai-target', 'native-observed', launch));
				expect(useSessionStore.getState().sessions[0]).toBe(captured);
				if (_label === 'Grok successor') {
					await act(async () => handler!('sess-1-ai-target', 'native-observed', next));
					expect(useSessionStore.getState().sessions[0].aiTabs[0].awaitingSessionId).toBe(false);
				}
			}
		);

		it('pins the first accepted generation and ignores unrelated utility attempts', async () => {
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
			const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
			for (const sessionId of ['sess-1-synopsis-123', 'sess-1-batch-123', 'sess-1-ai-other'])
				announceNativeAttempt({ sessionId, nativeSessionRequestId: 'unrelated' });
			await act(async () => handler!('sess-1-ai-target', 'native-observed', launch));
			const captured = useSessionStore.getState().sessions[0];
			expect(captured.aiTabs[0].awaitingSessionId).toBe(false);
			await act(async () =>
				handler!('sess-1-ai-target', 'native-observed', { ...launch, processGeneration: 8 })
			);
			expect(useSessionStore.getState().sessions[0]).toBe(captured);
		});

		it.each(['unmount and reload', 'older bridge'])(
			'requires a new attempt after %s, even for a retained matching ID',
			async (mode) => {
				const batched = makeBatched();
				const { unmount } = renderHook(() =>
					useAgentSessionIdListener({ batchedUpdater: batched })
				);
				const launch = announceNativeAttempt({ requestedNativeSessionId: 'native-observed' });
				unmount();
				expect(mockUnsubscribe).toHaveBeenCalledOnce();
				expect(mockAttemptUnsubscribe).toHaveBeenCalledOnce();
				if (mode === 'older bridge') window.maestro.process.onSpawnAttempt = undefined;
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
				const captured = useSessionStore.getState().sessions[0];
				await act(async () => handler!('sess-1-ai-target', 'native-observed', launch));
				expect(useSessionStore.getState().sessions[0]).toBe(captured);
			}
		);

		it('keeps account/host/cwd scopes distinct for colliding IDs across tabs after settings and provider change', async () => {
			const initial = useSessionStore.getState().sessions[0];
			useSessionStore.setState({
				sessions: [
					{
						...initial,
						aiTabs: ['target', 'other'].map((id) =>
							createMockAITab({
								id,
								turnProvider: 'grok',
								awaitingSessionId: true,
								logs: initial.aiTabs[0].logs,
								providerSessions: {
									codex: { agentSessionId: `codex-${id}`, customModel: 'incoming' },
								},
							})
						),
					},
				],
			});
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			const first = announceNativeAttempt();
			const second = {
				...announceNativeAttempt({
					sessionId: 'sess-1-ai-other',
					tabId: 'other',
					nativeSessionRequestId: 'request-2',
				}),
				processGeneration: 8,
				scope: {
					...nativeScope,
					accountRef: 'account-b',
					host: { kind: 'ssh' as const, identity: 'endpoint-b' },
					cwd: '/remote/project-b',
				},
			};
			act(() =>
				useSessionStore.setState(({ sessions }) => ({
					sessions: sessions.map((s) => ({
						...s,
						toolType: 'codex',
						cwd: '/remote/changed',
						customEnvVars: { GROK_HOME: '/remote/changed-account' },
						sessionSshRemoteConfig: { enabled: true, remoteId: 'changed-remote' },
						aiTabs: s.aiTabs.map((tab) => switchTabProvider(tab, 'grok', 'codex')),
					})),
				}))
			);
			const parked = useSessionStore.getState().sessions[0];
			const writes: Array<Array<{ id: string | null; binding: unknown }>> = [];
			const unsubscribe = useSessionStore.subscribe(({ sessions }) =>
				writes.push(
					sessions[0].aiTabs.map((t) => ({
						id: t.providerSessions!.grok!.agentSessionId,
						binding: t.providerSessions!.grok!.nativeSessionBinding,
					}))
				)
			);
			try {
				await act(async () => {
					await handler!('sess-1-ai-other', 'native-observed', second);
					await handler!('sess-1-ai-target', 'native-observed', first);
				});
			} finally {
				unsubscribe();
			}
			const updated = useSessionStore.getState().sessions[0];
			const bindings = [nativeBinding, { ...second.scope, nativeSessionId: 'native-observed' }];
			expect(writes).toEqual([
				[
					{ id: null, binding: undefined },
					{ id: 'native-observed', binding: bindings[1] },
				],
				bindings.map((binding) => ({ id: 'native-observed', binding })),
			]);
			expect(updated).toEqual({
				...parked,
				aiTabs: parked.aiTabs.map((tab, i) => ({
					...tab,
					providerSessions: {
						grok: {
							...tab.providerSessions!.grok,
							agentSessionId: 'native-observed',
							nativeSessionBinding: bindings[i],
						},
					},
				})),
			});
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});
	});
});
