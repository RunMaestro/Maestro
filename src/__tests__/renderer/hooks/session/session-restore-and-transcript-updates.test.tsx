// Source: src/__tests__/renderer/hooks/session/useThinkingItems.test.ts
// Source: src/__tests__/renderer/hooks/session/useBatchedSessionUpdates.test.ts
// Source: src/__tests__/renderer/hooks/session/useSessionRestoration.reattach.test.tsx
// Source: src/__tests__/renderer/hooks/session/useSessionRestoration.bootstrap.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { useThinkingItems } from '../../../../renderer/hooks/session/useThinkingItems';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMirroredPeer } from '../../../../shared/maestro-lib/client/peer-mirror';
import { replacePeerAgents } from '../../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../../helpers';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import { mergeContextWindow } from '../../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useBatchedSessionUpdates } from '../../../../renderer/hooks/session/useBatchedSessionUpdates';
import type { Session } from '../../../../renderer/types';
import type { UsageStats } from '../../../../renderer/types';
import { resetStore } from '../../../helpers/resetStores';
import { vi } from 'vitest';
import { afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useSessionRestoration } from '../../../../renderer/hooks/session/useSessionRestoration';
import { WEB_BRIDGE_RECONCILE_EVENT } from '../../../../shared/webClientConfig';
import * as permissionRegistry from '../../../../main/permission-relay/registry';
import { useSessionTranscriptSync } from '../../../../renderer/hooks/session/useSessionTranscriptSync';
import { cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { registerPersistenceHandlers } from '../../../../main/ipc/handlers/persistence';
import type { PersistenceHandlerDependencies } from '../../../../main/ipc/handlers/persistence';
import { broadcastBridgeEvent } from '../../../../main/web-server/handlers/bridgeHandlers';
import { WindowProvider } from '../../../../renderer/contexts/WindowContext';
import { gitService } from '../../../../renderer/services/git';
import { useGroupChatStore } from '../../../../renderer/stores/groupChatStore';
import type { SessionTranscriptPatch } from '../../../../shared/sessionTranscript';
import * as runtimeContext from '../../../../renderer/utils/runtimeContext';
const runtime = vi.hoisted(() => ({ web: true }));
vi.mock('electron', async () => {
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');
	return {
		ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
		app: { getPath: vi.fn(() => join(tmpdir(), 'maestro-bootstrap-test')), on: vi.fn() },
		BrowserWindow: { getAllWindows: vi.fn(() => []) },
	};
});
vi.mock('../../../../main/plugins/plugin-media-tools', () => ({
	getMediaToolStatus: vi.fn(),
	resolveMediaRuntime: vi.fn(),
	resolveMediaModelDirectory: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
	isBridgeInvokeEvent: (event: { type?: unknown } | null | undefined) => event?.type === 'bridge',
}));

describeSourceSuite('useThinkingItems', () => {
	function hydrateBusyPeer() {
		const { peer } = replacePeerAgents(
			createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
			[
				{
					id: 'a1',
					name: 'Builder',
					toolType: 'claude-code',
					aiTabs: [{ id: 'ht1', state: 'busy' }],
				},
			],
			[],
			1
		);
		usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
	}

	/** The Left Bar row that shows host agent box:a1 (idle locally: its turns run on the host). */
	const hostedRow = () =>
		createMockSession({ id: 'row-a1', liftedTo: { peer: 'box', agentId: 'a1', at: 1 } });

	describe('useThinkingItems', () => {
		beforeEach(() => {
			resetStores(usePeerMirrorStore, useSessionStore);
		});

		it('lists only local items while no peer is mirrored', () => {
			const session = createMockSession({
				id: 'local-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockAITab({ id: 't1', state: 'busy' })],
			});
			useSessionStore.setState({ sessions: [session] });
			const { result } = renderHook(() => useThinkingItems());
			expect(result.current.map((item) => item.session.id)).toEqual(['local-1']);
			expect(result.current[0].mirror).toBeUndefined();
		});

		it('appends the mirrored busy tabs after the local ones', () => {
			const session = createMockSession({
				id: 'local-1',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockAITab({ id: 't1', state: 'busy' })],
			});
			useSessionStore.setState({ sessions: [session, hostedRow()] });
			hydrateBusyPeer();
			const { result } = renderHook(() => useThinkingItems());
			expect(result.current.map((item) => item.session.id)).toEqual(['local-1', 'box:a1']);
			expect(result.current[1].mirror).toEqual({ peerId: 'box', agentId: 'a1' });
		});

		it("leaves out a host's busy agent the Left Bar does not show", () => {
			hydrateBusyPeer();
			const { result } = renderHook(() => useThinkingItems());
			expect(result.current).toEqual([]);
			act(() => useSessionStore.setState({ sessions: [hostedRow()] }));
			expect(result.current.map((item) => item.session.id)).toEqual(['box:a1']);
		});

		it('does not scope mirrored items by window ownership', () => {
			useSessionStore.setState({ sessions: [hostedRow()] });
			hydrateBusyPeer();
			const { result } = renderHook(() => useThinkingItems(() => false));
			expect(result.current.map((item) => item.session.id)).toEqual(['box:a1']);
		});

		it('picks up a mirrored tab that goes busy', () => {
			useSessionStore.setState({ sessions: [hostedRow()] });
			const { result } = renderHook(() => useThinkingItems());
			expect(result.current).toEqual([]);
			act(() => hydrateBusyPeer());
			expect(result.current.map((item) => item.tab?.id)).toEqual(['ht1']);
		});
	});
});
describeSourceSuite('useBatchedSessionUpdates', () => {
	const ONE_M = 1_000_000;
	const FALLBACK = 200_000;

	describe('useBatchedSessionUpdates keeps AI diagnostics separate from answers', () => {
		beforeEach(() => {
			resetStore(useSessionStore);
		});

		it.each([
			{ showThinking: 'off' as const, stderrFirst: true },
			{ showThinking: 'off' as const, stderrFirst: false },
			{ showThinking: 'on' as const, stderrFirst: true },
			{ showThinking: 'on' as const, stderrFirst: false },
			{ showThinking: 'sticky' as const, stderrFirst: true },
			{ showThinking: 'sticky' as const, stderrFirst: false },
		])(
			'preserves both channels with Thinking $showThinking and stderrFirst=$stderrFirst',
			({ showThinking, stderrFirst }) => {
				useSessionStore.setState({
					sessions: [
						createMockSession({
							id: 's1',
							state: 'busy',
							aiTabs: [createMockAITab({ id: 't1', state: 'busy', showThinking })],
						}),
					],
				});
				const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
				const channels = stderrFirst ? [true, false] : [false, true];

				act(() => {
					for (const isStderr of channels) {
						// Both channels arrive before a single flush. Same-channel chunks
						// still coalesce, but diagnostics never become assistant output.
						result.current.appendLog(
							's1',
							't1',
							true,
							isStderr ? 'Codex warning: ' : 'The ',
							isStderr
						);
						result.current.appendLog(
							's1',
							't1',
							true,
							isStderr ? 'ignored setting\n' : 'answer.',
							isStderr
						);
					}
					result.current.flushNow();
				});

				const session = useSessionStore.getState().sessions[0];
				const tab = session.aiTabs[0];
				expect(tab.logs.map(({ source, text }) => ({ source, text }))).toEqual(
					channels.map((isStderr) => ({
						source: isStderr ? 'stderr' : 'stdout',
						text: isStderr ? 'Codex warning: ignored setting\n' : 'The answer.',
					}))
				);
				expect(session.state).toBe('busy');
				expect(tab.state).toBe('busy');
				expect(tab.agentError).toBeUndefined();
			}
		);

		it.each(['on', 'sticky'] as const)(
			'keeps Thinking %s through a diagnostic and applies normal answer cleanup',
			(showThinking) => {
				const thinking = {
					id: 'thinking',
					timestamp: 1,
					source: 'thinking' as const,
					text: 'Working',
				};
				useSessionStore.setState({
					sessions: [
						createMockSession({
							id: 's1',
							aiTabs: [createMockAITab({ id: 't1', showThinking, logs: [thinking] })],
						}),
					],
				});
				const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
				act(() => {
					result.current.appendLog('s1', 't1', true, 'Codex warning: ignored setting\n', true);
					result.current.flushNow();
				});
				expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toEqual([
					thinking,
					expect.objectContaining({ source: 'stderr', text: 'Codex warning: ignored setting\n' }),
				]);

				act(() => {
					result.current.appendLog('s1', 't1', true, 'The answer.');
					result.current.flushNow();
				});
				const logs = useSessionStore.getState().sessions[0].aiTabs[0].logs;
				expect(logs.filter((log) => log.source === 'thinking')).toEqual(
					showThinking === 'sticky' ? [thinking] : []
				);
				expect(logs.slice(-2)).toEqual([
					expect.objectContaining({ source: 'stderr', text: 'Codex warning: ignored setting\n' }),
					expect.objectContaining({ source: 'stdout', text: 'The answer.' }),
				]);
			}
		);
	});

	describe('mergeContextWindow', () => {
		it('keeps a resolved window when an unresolved delta arrives', () => {
			expect(
				mergeContextWindow(
					{ contextWindow: FALLBACK },
					{ contextWindow: ONE_M, contextWindowResolved: true }
				)
			).toEqual({ contextWindow: ONE_M, contextWindowResolved: true });
		});

		it('keeps a resolved window when the delta explicitly says unresolved', () => {
			expect(
				mergeContextWindow(
					{ contextWindow: FALLBACK, contextWindowResolved: false },
					{ contextWindow: ONE_M, contextWindowResolved: true }
				)
			).toEqual({ contextWindow: ONE_M, contextWindowResolved: true });
		});

		it('lets a resolved delta replace a previously resolved window (model switch)', () => {
			expect(
				mergeContextWindow(
					{ contextWindow: FALLBACK, contextWindowResolved: true },
					{ contextWindow: ONE_M, contextWindowResolved: true }
				)
			).toEqual({ contextWindow: FALLBACK, contextWindowResolved: true });
		});

		it('takes the delta window before anything has resolved', () => {
			expect(mergeContextWindow({ contextWindow: FALLBACK }, undefined)).toEqual({
				contextWindow: FALLBACK,
				contextWindowResolved: undefined,
			});
			expect(mergeContextWindow({ contextWindow: FALLBACK }, { contextWindow: ONE_M })).toEqual({
				contextWindow: FALLBACK,
				contextWindowResolved: undefined,
			});
		});

		it('falls back to the existing window when the delta carries none', () => {
			expect(mergeContextWindow({ contextWindow: 0 }, { contextWindow: FALLBACK })).toEqual({
				contextWindow: FALLBACK,
				contextWindowResolved: undefined,
			});
			expect(mergeContextWindow({ contextWindow: 0 }, undefined)).toEqual({
				contextWindow: 0,
				contextWindowResolved: undefined,
			});
		});

		it('promotes an unresolved existing window when a resolved delta lands', () => {
			expect(
				mergeContextWindow(
					{ contextWindow: ONE_M, contextWindowResolved: true },
					{ contextWindow: FALLBACK }
				)
			).toEqual({ contextWindow: ONE_M, contextWindowResolved: true });
		});

		it('keeps a same-model resolved window across a transient unresolved delta', () => {
			expect(
				mergeContextWindow(
					{ contextWindow: FALLBACK, contextWindowModel: 'opus' },
					{ contextWindow: ONE_M, contextWindowResolved: true, contextWindowModel: 'opus' }
				)
			).toEqual({ contextWindow: ONE_M, contextWindowResolved: true, contextWindowModel: 'opus' });
		});

		it('does NOT keep a resolved window when a different model reports unresolved', () => {
			// Model switch to a model absent from the primed omp catalog: the gauge must
			// drop to the new model's fallback rather than stay on the old model's window.
			expect(
				mergeContextWindow(
					{ contextWindow: FALLBACK, contextWindowModel: 'haiku' },
					{ contextWindow: ONE_M, contextWindowResolved: true, contextWindowModel: 'opus' }
				)
			).toEqual({
				contextWindow: FALLBACK,
				contextWindowResolved: undefined,
				contextWindowModel: 'haiku',
			});
		});
	});

	/**
	 * The in-batch accumulator (updateUsage) folds multiple usage events that arrive
	 * between flushes. It now routes its context-window through the same
	 * `mergeContextWindow` rule as the flush path, so a resolved window is preserved
	 * even when a same-model unresolved fallback delta accumulates on top of it
	 * before the batch commits. Token accounting is unchanged.
	 */
	describe('useBatchedSessionUpdates accumulator preserves resolved window', () => {
		const resolved = (over: Partial<UsageStats> = {}): UsageStats => ({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.02,
			contextWindow: ONE_M,
			contextWindowResolved: true,
			contextWindowModel: 'opus',
			...over,
		});

		// Same model, but the main process re-emits the 200k fallback (catalog not
		// re-primed for this turn). Must NOT downgrade the gauge.
		const unresolvedFallback = (over: Partial<UsageStats> = {}): UsageStats => ({
			inputTokens: 20,
			outputTokens: 10,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: FALLBACK,
			contextWindowModel: 'opus',
			...over,
		});

		beforeEach(() => {
			useSessionStore.setState({ sessions: [] } as never);
		});

		it('keeps the resolved window when a same-model fallback delta accumulates (session-level)', () => {
			useSessionStore.setState({
				sessions: [{ id: 's1' } as unknown as Session],
			} as never);

			const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
			act(() => {
				result.current.updateUsage('s1', null, resolved());
				result.current.updateUsage('s1', null, unresolvedFallback());
				result.current.flushNow();
			});

			const stats = useSessionStore.getState().sessions[0].usageStats;
			expect(stats?.contextWindow).toBe(ONE_M);
			expect(stats?.contextWindowResolved).toBe(true);
			// Token accounting still accumulates both deltas at the session level.
			expect(stats?.inputTokens).toBe(120);
			expect(stats?.outputTokens).toBe(60);
		});

		it('keeps the resolved window when a same-model fallback delta accumulates (tab-level)', () => {
			useSessionStore.setState({
				sessions: [
					{
						id: 's1',
						aiTabs: [{ id: 't1', logs: [] }],
					} as unknown as Session,
				],
			} as never);

			const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
			act(() => {
				result.current.updateUsage('s1', 't1', resolved());
				result.current.updateUsage('s1', 't1', unresolvedFallback());
				result.current.flushNow();
			});

			const tab = useSessionStore.getState().sessions[0].aiTabs?.[0];
			expect(tab?.usageStats?.contextWindow).toBe(ONE_M);
			expect(tab?.usageStats?.contextWindowResolved).toBe(true);
		});
	});

	/**
	 * A tab's usage record used to drop the provider's occupancy snapshot, leaving
	 * the header gauge only the turn's summed token spend to measure. On a 1M
	 * window that sum stays under the limit, so it was displayed as the context
	 * size (issue #1782). The snapshot now rides with the input/cache fields.
	 */
	describe('useBatchedSessionUpdates carries the occupancy snapshot on a tab', () => {
		const snapshot = (inputTokens: number): NonNullable<UsageStats['absoluteUsage']> => ({
			inputTokens,
			outputTokens: 600,
			cacheReadInputTokens: 78_900,
			cacheCreationInputTokens: 4_500,
			reasoningTokens: 0,
		});

		const turn = (over: Partial<UsageStats> = {}): UsageStats => ({
			inputTokens: 22,
			outputTokens: 4_100,
			cacheReadInputTokens: 437_222,
			cacheCreationInputTokens: 89_297,
			totalCostUsd: 0.4,
			contextWindow: ONE_M,
			contextWindowResolved: true,
			contextWindowModel: 'opus',
			...over,
		});

		const tabStats = () => useSessionStore.getState().sessions[0].aiTabs?.[0]?.usageStats;

		beforeEach(() => {
			useSessionStore.setState({
				sessions: [{ id: 's1', aiTabs: [{ id: 't1', logs: [] }] } as unknown as Session],
			} as never);
		});

		it('stores the snapshot beside the turn totals', () => {
			const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
			act(() => {
				result.current.updateUsage('s1', 't1', turn({ absoluteUsage: snapshot(3) }));
				result.current.flushNow();
			});

			expect(tabStats()?.absoluteUsage).toEqual(snapshot(3));
			// The turn's spend is untouched: it still feeds the token rows.
			expect(tabStats()?.cacheReadInputTokens).toBe(437_222);
		});

		it('keeps the newest snapshot when two reports land in one batch', () => {
			const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
			act(() => {
				result.current.updateUsage('s1', 't1', turn({ absoluteUsage: snapshot(3) }));
				result.current.updateUsage('s1', 't1', turn({ absoluteUsage: snapshot(9) }));
				result.current.flushNow();
			});

			expect(tabStats()?.absoluteUsage).toEqual(snapshot(9));
		});

		it('drops a stale snapshot when a later real report carries none', () => {
			const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
			act(() => {
				result.current.updateUsage('s1', 't1', turn({ absoluteUsage: snapshot(3) }));
				result.current.flushNow();
			});
			act(() => {
				result.current.updateUsage('s1', 't1', turn({ cacheReadInputTokens: 50_000 }));
				result.current.flushNow();
			});

			expect(tabStats()?.cacheReadInputTokens).toBe(50_000);
			expect(tabStats()?.absoluteUsage).toBeUndefined();
		});

		it('preserves the snapshot across an output-only delta and a window correction', () => {
			const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
			act(() => {
				result.current.updateUsage('s1', 't1', turn({ absoluteUsage: snapshot(3) }));
				result.current.flushNow();
			});
			act(() => {
				result.current.updateUsage(
					's1',
					't1',
					turn({
						inputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						outputTokens: 120,
					})
				);
				result.current.flushNow();
			});
			expect(tabStats()?.absoluteUsage).toEqual(snapshot(3));

			act(() => {
				result.current.updateUsage('s1', 't1', turn({ contextWindowCorrectionOnly: true }));
				result.current.flushNow();
			});
			expect(tabStats()?.absoluteUsage).toEqual(snapshot(3));
		});
	});
});
describeSourceSuite('useSessionRestoration.reattach', () => {
	const RUNNING_AGENT = createMockSession({
		id: 'agent-1',
		state: 'busy',
		aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		activeTabId: 'tab-1',
	});

	function mockMaestro(activeProcesses: unknown[]) {
		const maestro = (window as any).maestro;
		maestro.sessions = {
			...maestro.sessions,
			getAll: vi.fn().mockResolvedValue([RUNNING_AGENT]),
			getActiveSessionId: vi.fn().mockResolvedValue('agent-1'),
			setActiveSessionId: vi.fn().mockResolvedValue(undefined),
		};
		maestro.groups = { ...maestro.groups, getAll: vi.fn().mockResolvedValue([]) };
		maestro.groupChat = { ...maestro.groupChat, list: vi.fn().mockResolvedValue([]) };
		maestro.agents = { ...maestro.agents, get: vi.fn().mockResolvedValue({ id: 'claude-code' }) };
		maestro.process = {
			...maestro.process,
			getActiveProcesses: vi.fn().mockResolvedValue(activeProcesses),
		};
	}

	const agentState = () => useSessionStore.getState().sessions.find((s) => s.id === 'agent-1');

	beforeEach(() => {
		useSessionStore.setState({ sessions: [], initialLoadComplete: false, sessionsLoaded: false });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('useSessionRestoration - live turn reattach (#1464)', () => {
		it('restores busy state for an agent main is still running', async () => {
			mockMaestro([
				{
					sessionId: 'agent-1-ai-tab-1',
					toolType: 'claude-code',
					pid: 4242,
					cwd: '/test/project',
					isTerminal: false,
					startTime: 1000,
				},
			]);

			renderHook(() => useSessionRestoration());

			await waitFor(() => expect(agentState()?.state).toBe('busy'));
			expect(agentState()).toMatchObject({
				busySource: 'ai',
				thinkingStartTime: 1000,
				aiPid: 4242,
			});
			expect(agentState()?.aiTabs[0]).toMatchObject({ state: 'busy', thinkingStartTime: 1000 });
		});

		it('leaves the agent idle when main is running nothing for it', async () => {
			mockMaestro([]);

			renderHook(() => useSessionRestoration());

			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(agentState()?.state).toBe('idle');
			expect(agentState()?.aiTabs[0].state).toBe('idle');
		});

		it('leaves the agent idle when the probe itself fails', async () => {
			mockMaestro([]);
			(window as any).maestro.process.getActiveProcesses = vi
				.fn()
				.mockRejectedValue(new Error('bridge down'));

			renderHook(() => useSessionRestoration());

			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(agentState()?.state).toBe('idle');
		});

		it('releases connection-held prompts after bridge reconciliation succeeds', async () => {
			mockMaestro([]);
			const getActiveProcesses = vi
				.mocked((window as any).maestro.process.getActiveProcesses)
				.mockRejectedValue(new Error('bridge down'));

			renderHook(() => useSessionRestoration());

			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			act(() => {
				useSessionStore.getState().setSessions([
					{
						...agentState()!,
						executionQueue: [
							{
								id: 'held-message',
								timestamp: 1,
								tabId: 'tab-1',
								type: 'message',
								text: 'send me after reconnect',
								waitingForConnection: true,
							},
						],
					},
				]);
			});
			getActiveProcesses.mockResolvedValue([]);

			act(() => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));

			await waitFor(() =>
				expect(agentState()?.executionQueue[0].waitingForConnection).toBeUndefined()
			);
			expect(agentState()?.state).toBe('idle');
		});

		it('retries a failed reconcile while a connection-held prompt remains', async () => {
			mockMaestro([]);
			const getActiveProcesses = vi.mocked((window as any).maestro.process.getActiveProcesses);

			renderHook(() => useSessionRestoration());

			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			await waitFor(() => expect(getActiveProcesses).toHaveBeenCalledTimes(1));
			act(() => {
				useSessionStore.getState().setSessions([
					{
						...agentState()!,
						executionQueue: [
							{
								id: 'held-message',
								timestamp: 1,
								tabId: 'tab-1',
								type: 'message',
								text: 'retry the reconcile',
								waitingForConnection: true,
							},
						],
					},
				]);
			});
			getActiveProcesses.mockRejectedValueOnce(new Error('bridge down')).mockResolvedValue([]);
			vi.useFakeTimers();

			await act(async () => {
				window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT));
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(agentState()?.executionQueue[0].waitingForConnection).toBe(true);

			await act(async () => {
				vi.advanceTimersByTime(1000);
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(getActiveProcesses).toHaveBeenCalledTimes(3);
			expect(agentState()?.executionQueue[0].waitingForConnection).toBeUndefined();
		});

		it('preserves the sessions array when a reconcile has no work', async () => {
			mockMaestro([]);
			const getActiveProcesses = vi.mocked((window as any).maestro.process.getActiveProcesses);

			renderHook(() => useSessionRestoration());

			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			await waitFor(() => expect(getActiveProcesses).toHaveBeenCalledTimes(1));
			const before = useSessionStore.getState().sessions;

			await act(async () => {
				window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT));
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(useSessionStore.getState().sessions).toBe(before);
		});
	});
});
describe('useSessionRestoration.bootstrap', () => {
	// Exercise the real main IPC handler and browser restoration together. Only the
	// Electron transport, stored records, and owning host process are boundaries.
	const handlers = new Map<string, (...args: any[]) => any>();
	let stored: ReturnType<typeof createMockSession>[];
	let hostRuntime: Map<string, Record<string, unknown>>;
	let receive: ((patch: SessionTranscriptPatch) => void) | undefined;
	let holdReplies: boolean;
	let pendingReplies: (() => void)[];
	let bootstrapResponses: Awaited<ReturnType<typeof window.maestro.sessions.getBootstrap>>[];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(runtimeContext, 'isWebDesktop').mockImplementation(() => runtime.web);
		vi.spyOn(runtimeContext, 'isElectronDesktop').mockImplementation(() => !runtime.web);
		vi.spyOn(gitService, 'isRepo').mockResolvedValue(false);
		runtime.web = true;
		handlers.clear();
		receive = undefined;
		bootstrapResponses = [];
		holdReplies = false;
		pendingReplies = [];
		document.title = 'Maestro';
		stored = ['selected', 'waiting-a', 'waiting-b'].map((id) =>
			createMockSession({
				id,
				state: 'idle',
				activeTabId: 'tab-1',
				aiTabs: [createMockAITab({ id: 'tab-1', logs: [] })],
			})
		);
		hostRuntime = new Map([
			['selected', { state: 'idle' }],
			['waiting-a', { state: 'waiting_input' }],
			['waiting-b', { state: 'waiting_input' }],
		]);
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerPersistenceHandlers({
			settingsStore: { get: (_key: string, fallback: unknown) => fallback, store: {} },
			sessionsStore: {
				get: (key: string, fallback: unknown) => (key === 'sessions' ? stored : fallback),
			},
			groupsStore: { get: (_key: string, fallback: unknown) => fallback },
			getWebServer: () => null,
		} as unknown as PersistenceHandlerDependencies);
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
			{
				isDestroyed: () => false,
				webContents: {
					id: 1,
					isDestroyed: () => false,
					send: (
						channel: string,
						request: {
							sessionId: string;
							tabId: string;
							requestId: string;
							metadataOnly: boolean;
						}
					) => {
						if (channel !== 'sessions:transcriptRequest') return;
						expect(request.metadataOnly).toBe(true);
						expect(request.tabId).toBe('');
						const runtime = { ...hostRuntime.get(request.sessionId) };
						const publish = () =>
							handlers.get('sessions:publishTranscript')!(
								{ sender: { id: 1 } },
								{
									sessionId: request.sessionId,
									field: 'shellLogs',
									upserts: [],
									removedIds: [],
									orderIds: [],
									snapshot: true,
									runtime,
								},
								request.requestId
							);
						if (holdReplies) pendingReplies.push(publish);
						else publish();
					},
				},
			},
		] as unknown as BrowserWindow[]);
		vi.mocked(broadcastBridgeEvent).mockImplementation((channel, args) => {
			if (channel === 'sessions:transcriptSync') receive?.(args[0] as SessionTranscriptPatch);
		});
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: false,
			sessionsReadOk: false,
			groupsLoaded: false,
		});
		useGroupChatStore.setState({ groupChats: [] });
		window.maestro.sessions = {
			...window.maestro.sessions,
			getBootstrap: vi.fn(async () => {
				const response = JSON.parse(
					JSON.stringify(await handlers.get('sessions:getBootstrap')!({ type: 'bridge' }))
				);
				bootstrapResponses.push(response);
				return response;
			}),
			getActiveSessionId: vi.fn().mockResolvedValue('selected'),
			setActiveSessionId: vi.fn(),
			onTranscriptSync: (handler) => {
				receive = handler;
				return () => {
					receive = undefined;
				};
			},
			publishTranscript: vi.fn().mockResolvedValue(true),
		};
		window.maestro.groups.getAll = vi.fn().mockResolvedValue([]);
		window.maestro.groupChat = { ...window.maestro.groupChat, list: vi.fn().mockResolvedValue([]) };
		window.maestro.agents.get = vi.fn().mockResolvedValue({ id: 'claude-code' });
		window.maestro.process.getActiveProcesses = vi.fn().mockResolvedValue([
			{ sessionId: 'waiting-a-ai-tab-1', pid: 41, isTerminal: false },
			{ sessionId: 'waiting-b-ai-tab-1', pid: 42, isTerminal: false },
		]);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	describe('browser git metadata through real bootstrap IPC', () => {
		it('restores host git metadata without scanning every agent', async () => {
			const metadata = {
				isGitRepo: true,
				gitBranches: ['main', 'host-branch'],
				gitTags: ['v1.0'],
				gitRefsCacheTime: 1234,
			};
			stored = stored.map((session) => ({ ...session, ...metadata }));
			renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(bootstrapResponses).toHaveLength(1);
			for (const session of stored) {
				expect(bootstrapResponses[0].find((item) => item.id === session.id)).toMatchObject(
					metadata
				);
				expect(
					useSessionStore.getState().sessions.find((item) => item.id === session.id)
				).toMatchObject(metadata);
			}
			expect(gitService.isRepo).not.toHaveBeenCalled();
		});
	});

	describe('browser input-request title through real bootstrap IPC', () => {
		it('counts already-waiting background agents on open and reload without a host event', async () => {
			stored[1].aiTabs[0].logs = [
				{ id: 'deferred-row', timestamp: 1, source: 'user', text: 'background transcript' },
			];
			const view = renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(document.title).toBe('(2) Maestro');
			expect(useSessionStore.getState().activeSessionId).toBe('selected');
			expect(broadcastBridgeEvent).not.toHaveBeenCalled();
			expect(bootstrapResponses).toHaveLength(1);
			const waiting = bootstrapResponses[0].find((session) => session.id === 'waiting-a')!;
			expect(waiting.aiTabs[0].logs).toEqual([]);
			expect(waiting.shellLogs).toEqual([]);
			expect(waiting.agentCommands).toBeUndefined();
			expect(waiting.transcriptSnapshots).toEqual([
				{
					sessionId: 'waiting-a',
					runtime: { state: 'waiting_input' },
					clearRuntimeFields: undefined,
				},
			]);
			expect(
				useSessionStore.getState().sessions.every((session) => !('transcriptSnapshots' in session))
			).toBe(true);
			view.unmount();
			useSessionStore.setState({ sessions: [], sessionsLoaded: false, sessionsReadOk: false });
			renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
			expect(document.title).toBe('(2) Maestro');
			expect(broadcastBridgeEvent).not.toHaveBeenCalled();
		});
		it('refreshes answered background requests on reconnect without a host event', async () => {
			renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(document.title).toBe('(2) Maestro'));
			hostRuntime.set('waiting-a', { state: 'busy' });
			hostRuntime.set('waiting-b', { state: 'idle' });
			await act(async () => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));
			await waitFor(() => expect(document.title).toBe('Maestro'));
			expect(useSessionStore.getState().sessions.find((s) => s.id === 'waiting-a')?.state).toBe(
				'busy'
			);
			expect(broadcastBridgeEvent).not.toHaveBeenCalled();

			hostRuntime.set('waiting-a', { state: 'waiting_input' });
			hostRuntime.set('waiting-b', { state: 'waiting_input' });
			await act(async () => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));
			await waitFor(() => expect(document.title).toBe('(2) Maestro'));
			const answer: SessionTranscriptPatch = {
				sessionId: 'waiting-a',
				field: 'shellLogs',
				upserts: [],
				removedIds: [],
				orderIds: [],
				runtime: { state: 'busy' },
			};
			await act(async () => {
				await handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, answer);
				await handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, answer);
			});
			expect(document.title).toBe('(1) Maestro');
			await act(async () => {
				await handlers.get('sessions:publishTranscript')!(
					{ sender: { id: 1 } },
					{
						...answer,
						sessionId: 'waiting-b',
						runtime: { state: 'idle' },
					}
				);
			});
			expect(document.title).toBe('Maestro');
		});

		it('keeps newer host answers when an older reconnect snapshot finishes later', async () => {
			renderHook(() => useSessionRestoration(), {
				wrapper: ({ children }) => createElement(WindowProvider, { children }),
			});
			await waitFor(() => expect(document.title).toBe('(2) Maestro'));
			holdReplies = true;
			act(() => window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT)));
			await waitFor(() => expect(pendingReplies).toHaveLength(3));
			const answer: SessionTranscriptPatch = {
				sessionId: 'waiting-a',
				field: 'shellLogs',
				upserts: [],
				removedIds: [],
				orderIds: [],
				runtime: { state: 'busy' },
				clearRuntimeFields: ['statusMessage'],
			};
			await act(async () => {
				hostRuntime.set('waiting-a', { state: 'busy' });
				await handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, answer);
			});
			expect(document.title).toBe('(1) Maestro');
			await act(async () => {
				for (const reply of pendingReplies) reply();
			});
			await waitFor(() => expect(bootstrapResponses).toHaveLength(2));
			expect(document.title).toBe('(1) Maestro');
			expect(
				useSessionStore.getState().sessions.find((session) => session.id === 'waiting-a')?.state
			).toBe('busy');
		});
		it('carries a real relay request through the native runtime owner and browser bootstrap', async () => {
			runtime.web = false;
			for (const session of stored) hostRuntime.set(session.id, { state: 'idle' });
			useSessionStore.setState({
				sessions: stored.map((session) =>
					session.id === 'waiting-a'
						? {
								...session,
								state: 'busy',
								aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
							}
						: session
				),
				sessionsLoaded: true,
				initialLoadComplete: true,
			});
			window.maestro.process.getPendingPermissions = vi.fn(async () =>
				permissionRegistry.getPendingPermissionSnapshot()
			);
			window.maestro.process.onPendingPermissionsChanged =
				permissionRegistry.subscribePendingPermissions;
			window.maestro.sessions.publishTranscript = vi.fn(async (patch, requestId) => {
				if (!patch.tabId && patch.runtime) hostRuntime.set(patch.sessionId, patch.runtime);
				return handlers.get('sessions:publishTranscript')!({ sender: { id: 1 } }, patch, requestId);
			});
			const host = renderHook(() => useSessionTranscriptSync(async () => {}));
			const spawn = permissionRegistry.registerSpawn({
				sessionId: 'waiting-a-ai-tab-1',
				tabId: 'tab-1',
			});
			let browser: ReturnType<typeof renderHook> | undefined;
			try {
				await act(async () => {
					void permissionRegistry.createPending('bootstrap-real-request', spawn.token);
				});
				expect(useSessionStore.getState().sessions.find((s) => s.id === 'waiting-a')?.state).toBe(
					'waiting_input'
				);
				expect(hostRuntime.get('waiting-a')?.state).toBe('waiting_input');
				host.unmount();
				runtime.web = true;
				vi.mocked(broadcastBridgeEvent).mockClear();
				useSessionStore.setState({ sessions: [], sessionsLoaded: false, sessionsReadOk: false });
				browser = renderHook(() => useSessionRestoration(), {
					wrapper: ({ children }) => createElement(WindowProvider, { children }),
				});
				await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
				expect(document.title).toBe('(1) Maestro');
				expect(broadcastBridgeEvent).not.toHaveBeenCalled();
				browser.unmount();
				useSessionStore.setState({ sessions: [], sessionsLoaded: false, sessionsReadOk: false });
				browser = renderHook(() => useSessionRestoration(), {
					wrapper: ({ children }) => createElement(WindowProvider, { children }),
				});
				await waitFor(() => expect(useSessionStore.getState().sessionsLoaded).toBe(true));
				expect(document.title).toBe('(1) Maestro');
				expect(broadcastBridgeEvent).not.toHaveBeenCalled();
			} finally {
				host.unmount();
				browser?.unmount();
				permissionRegistry.resolvePending('bootstrap-real-request', { behavior: 'allow' });
				spawn.cleanup();
				delete (window.maestro.process as any).getPendingPermissions;
				delete (window.maestro.process as any).onPendingPermissionsChanged;
			}
		});
	});
});
