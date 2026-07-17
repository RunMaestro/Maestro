import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRuntimeFeaturesListener } from '../../../../../renderer/hooks/agent/internal/useRuntimeFeaturesListener';
import { useBatchedSessionUpdates } from '../../../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useAgentToolExecutionListener } from '../../../../../renderer/hooks/agent/internal/useAgentToolExecutionListener';
import { useAgentThinkingListener } from '../../../../../renderer/hooks/agent/internal/useAgentThinkingListener';
import { useOmpEventCoordinator } from '../../../../../renderer/hooks/agent/internal/useOmpEventCoordinator';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type { AgentRuntimeFeatureState } from '../../../../../shared/agent-runtime-features';
import type { Session } from '../../../../../renderer/types';

const { ownedGate, openInSystemBrowser } = vi.hoisted(() => ({
	ownedGate: { current: (sessionId: string) => sessionId.startsWith('owned-session') },
	openInSystemBrowser: vi.fn(),
}));
let onOpenExternalUrl: ((sessionId: string, url: string) => void) | undefined;
let onRuntimeFeatures:
	| ((sessionId: string, features: AgentRuntimeFeatureState | null) => void)
	| undefined;
let onOmpTurnLifecycle:
	| ((
			sessionId: string,
			event: {
				phase: 'turn_end' | 'agent_start' | 'continuation_failed';
				continuation?: boolean;
				deliveryIntent?: 'follow_up' | 'abort_and_prompt';
				deliveryId?: string;
			}
	  ) => void)
	| undefined;
let onToolExecution:
	| ((
			sessionId: string,
			event: {
				toolName: string;
				state?: unknown;
				timestamp: number;
				toolCallId?: string;
			}
	  ) => void)
	| undefined;
let onThinkingChunk: ((sessionId: string, content: string) => void) | undefined;

vi.mock('../../../../../renderer/hooks/agent/internal/useOwnedSessionGate', () => ({
	useOwnedSessionGate: () => ownedGate,
}));
vi.mock('../../../../../renderer/utils/openUrl', () => ({ openInSystemBrowser }));

const unsubscribe = vi.fn();
const mockProcess = {
	onRuntimeFeatures: vi.fn(
		(handler: (sessionId: string, features: AgentRuntimeFeatureState | null) => void) => {
			onRuntimeFeatures = handler;
			return unsubscribe;
		}
	),
	onApprovalRequest: vi.fn(() => unsubscribe),
	onApprovalCancelled: vi.fn(() => unsubscribe),
	onOpenExternalUrl: vi.fn((handler: (sessionId: string, url: string) => void) => {
		onOpenExternalUrl = handler;
		return unsubscribe;
	}),
	onComposerText: vi.fn(() => unsubscribe),
	onSessionTitle: vi.fn(() => unsubscribe),
	onOmpTurnLifecycle: vi.fn(
		(
			handler: (
				sessionId: string,
				event: {
					phase: 'turn_end' | 'agent_start' | 'continuation_failed';
					continuation?: boolean;
					deliveryIntent?: 'follow_up' | 'abort_and_prompt';
					deliveryId?: string;
				}
			) => void
		) => {
			onOmpTurnLifecycle = handler;
			return unsubscribe;
		}
	),
	onToolExecution: vi.fn(
		(
			handler: (
				sessionId: string,
				event: {
					toolName: string;
					state?: unknown;
					timestamp: number;
					toolCallId?: string;
				}
			) => void
		) => {
			onToolExecution = handler;
			return unsubscribe;
		}
	),
	onThinkingChunk: vi.fn((handler: (sessionId: string, content: string) => void) => {
		onThinkingChunk = handler;
		return unsubscribe;
	}),
};

function featureState(marker: string): AgentRuntimeFeatureState {
	return {
		controls: [{ id: 'thinking-level', label: marker, kind: 'select' }],
		tree: null,
		todos: null,
		subagents: null,
		stats: null,
	};
}

function seedSession(): void {
	// Cast: the listener touches only id/aiTabs/runtimeFeatures/pendingApprovals,
	// so a minimal session shape is sufficient.
	const session = {
		id: 'owned-session',
		activeTabId: 'tab-a',
		aiTabs: [
			{ id: 'tab-a', runtimeFeatures: featureState('seed-a') },
			{ id: 'tab-b', runtimeFeatures: featureState('seed-b') },
		],
		runtimeFeatures: featureState('seed-base'),
		pendingApprovals: [],
	} as unknown as Session;
	useSessionStore.setState({ sessions: [session] });
}

function storedSession(): Session {
	return useSessionStore.getState().sessions[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	onOpenExternalUrl = undefined;
	onRuntimeFeatures = undefined;
	onOmpTurnLifecycle = undefined;
	onToolExecution = undefined;
	onThinkingChunk = undefined;
	// the preload bridge surface is irrelevant to this suite.
	const processBridge = mockProcess as unknown as typeof window.maestro.process;
	window.maestro = { ...window.maestro, process: processBridge };
	seedSession();
});

describe('useRuntimeFeaturesListener', () => {
	it('opens broadcast URLs only in the owning Maestro window', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onOpenExternalUrl!('foreign-session', 'https://example.com/foreign');
		expect(openInSystemBrowser).not.toHaveBeenCalled();

		onOpenExternalUrl!('owned-session', 'https://example.com/owned');
		expect(openInSystemBrowser).toHaveBeenCalledOnce();
		expect(openInSystemBrowser).toHaveBeenCalledWith('https://example.com/owned');
	});

	it('applies tab-scoped feature events only to the owning tab', () => {
		renderHook(() => useRuntimeFeaturesListener());
		const next = featureState('live-b');

		onRuntimeFeatures!('owned-session-ai-tab-b', next);

		const session = storedSession();
		expect(session.aiTabs[1].runtimeFeatures).toEqual(next);
		// Neither the base session nor the sibling tab is touched.
		expect(session.runtimeFeatures?.controls[0].label).toBe('seed-base');
		expect(session.aiTabs[0].runtimeFeatures?.controls[0].label).toBe('seed-a');
	});

	it('clearing inactive tab A never clears live tab B or the base projection', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onRuntimeFeatures!('owned-session-ai-tab-a', null);

		const session = storedSession();
		expect(session.aiTabs[0].runtimeFeatures).toBeUndefined();
		expect(session.aiTabs[1].runtimeFeatures?.controls[0].label).toBe('seed-b');
		expect(session.runtimeFeatures?.controls[0].label).toBe('seed-base');
	});

	it('applies base-scoped feature events only to the base session', () => {
		renderHook(() => useRuntimeFeaturesListener());
		const next = featureState('live-base');

		onRuntimeFeatures!('owned-session', next);

		const session = storedSession();
		expect(session.runtimeFeatures).toEqual(next);
		expect(session.aiTabs[0].runtimeFeatures?.controls[0].label).toBe('seed-a');
		expect(session.aiTabs[1].runtimeFeatures?.controls[0].label).toBe('seed-b');
	});

	it('reasserts busy and consumes one queued follow-up only at its continuation start', () => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				state: 'idle',
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								logs: [
									{
										id: 'first-prompt',
										timestamp: 1,
										source: 'user',
										text: 'first request',
									},
									{ id: 'output-a', timestamp: 2, source: 'ai', text: 'output A' },
									{
										id: 'queued-follow-up',
										timestamp: 3,
										source: 'user',
										text: 'run after this',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
									{ id: 'output-b', timestamp: 4, source: 'ai', text: 'output B' },
								],
							}
						: tab
				),
			})),
		}));
		renderHook(() => useRuntimeFeaturesListener());

		onOmpTurnLifecycle!('owned-session-ai-tab-a', { phase: 'turn_end' });
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'follow_up',
			deliveryId: 'queued-follow-up',
		});

		const session = storedSession();
		expect(session.state).toBe('busy');
		expect(session.aiTabs[0].state).toBe('busy');
		const logs = session.aiTabs[0].logs;
		expect(logs.slice(0, 3).map((log) => log.id)).toEqual(['first-prompt', 'output-a', 'output-b']);
		expect(logs[3]?.metadata?.ompTurnBoundary).toBe(true);
		expect(logs.at(-1)?.deliveryState).toBe('consumed');
	});

	it('marks a queued continuation failed when native cannot start it', () => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								logs: [
									{
										id: 'older-follow-up',
										timestamp: 1,
										source: 'user',
										text: 'older queued request',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
									{
										id: 'failed-follow-up',
										timestamp: 2,
										source: 'user',
										text: 'run after this',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
								],
							}
						: tab
				),
			})),
		}));
		renderHook(() => useRuntimeFeaturesListener());

		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: 'failed-follow-up',
		});
		expect(storedSession().aiTabs[0].logs.map((log) => log.deliveryState)).toEqual([
			'queued',
			'failed',
		]);
	});

	it('never mutates queued receipts for missing, spoofed, wrong-intent, consumed, or cross-tab IDs', () => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				aiTabs: session.aiTabs.map((tab) => ({
					...tab,
					logs:
						tab.id === 'tab-a'
							? [
									{
										id: 'tab-a-follow-up',
										timestamp: 1,
										source: 'user',
										text: 'tab A',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
									{
										id: 'consumed-follow-up',
										timestamp: 2,
										source: 'user',
										text: 'already consumed',
										deliveryIntent: 'follow_up',
										deliveryState: 'consumed',
									},
								]
							: [
									{
										id: 'tab-b-follow-up',
										timestamp: 3,
										source: 'user',
										text: 'tab B',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
								],
				})),
			})),
		}));
		renderHook(() => useRuntimeFeaturesListener());

		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
		});
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: 'old-or-spoofed-id',
		});
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'continuation_failed',
			deliveryIntent: 'abort_and_prompt',
			deliveryId: 'tab-a-follow-up',
		});
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: 'tab-b-follow-up',
		});
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'continuation_failed',
			deliveryIntent: 'follow_up',
			deliveryId: 'consumed-follow-up',
		});

		expect(
			storedSession()
				.aiTabs.flatMap((tab) => tab.logs)
				.map((log) => log.deliveryState)
		).toEqual(['queued', 'consumed', 'queued']);
	});

	it('moves each queued atomic replacement immediately into its continuation boundary', () => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								logs: [
									{ id: 'first', timestamp: 1, source: 'user', text: 'first' },
									{ id: 'aborted-output', timestamp: 2, source: 'ai', text: 'aborted' },
									{
										id: 'replacement-one',
										timestamp: 3,
										source: 'user',
										text: 'replacement one',
										deliveryIntent: 'abort_and_prompt',
										deliveryState: 'queued',
									},
									{ id: 'final-aborted-output', timestamp: 4, source: 'ai', text: 'final aborted' },
								],
							}
						: tab
				),
			})),
		}));
		renderHook(() => useRuntimeFeaturesListener());

		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'abort_and_prompt',
			deliveryId: 'replacement-one',
		});
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								logs: [
									...tab.logs,
									{
										id: 'replacement-output',
										timestamp: 5,
										source: 'ai',
										text: 'replacement output',
									},
									{
										id: 'replacement-two',
										timestamp: 6,
										source: 'user',
										text: 'replacement two',
										deliveryIntent: 'abort_and_prompt',
										deliveryState: 'queued',
									},
									{
										id: 'second-aborted-output',
										timestamp: 7,
										source: 'ai',
										text: 'second aborted',
									},
								],
							}
						: tab
				),
			})),
		}));
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'abort_and_prompt',
			deliveryId: 'replacement-two',
		});

		const logs = storedSession().aiTabs[0].logs;
		expect(logs.filter((log) => !log.metadata?.ompTurnBoundary).map((log) => log.id)).toEqual([
			'first',
			'aborted-output',
			'final-aborted-output',
			'replacement-one',
			'replacement-output',
			'second-aborted-output',
			'replacement-two',
		]);
		expect(logs.filter((log) => log.deliveryState === 'consumed').map((log) => log.id)).toEqual([
			'replacement-one',
			'replacement-two',
		]);
		const firstReplacement = logs.findIndex((log) => log.id === 'replacement-one');
		const secondReplacement = logs.findIndex((log) => log.id === 'replacement-two');
		expect(logs[firstReplacement - 1]?.metadata?.ompTurnBoundary).toBe(true);
		expect(logs[secondReplacement - 1]?.metadata?.ompTurnBoundary).toBe(true);
	});

	it('seals the preceding receipt and retimes a consumed continuation to its actual start', () => {
		vi.spyOn(Date, 'now')
			.mockReturnValueOnce(20_000)
			.mockReturnValueOnce(20_000)
			.mockReturnValueOnce(21_000);
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								logs: [
									{ id: 'first', timestamp: 0, source: 'user', text: 'First request' },
									{
										id: 'queued',
										timestamp: 1_000,
										source: 'user',
										text: 'Follow-up request',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
								],
							}
						: tab
				),
			})),
		}));
		renderHook(() => useRuntimeFeaturesListener());

		onOmpTurnLifecycle!('owned-session-ai-tab-a', { phase: 'turn_end' });
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'follow_up',
			deliveryId: 'queued',
		});
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								logs: [
									...tab.logs,
									{ id: 'second-output', timestamp: 21_000, source: 'ai', text: 'Second' },
								],
							}
						: tab
				),
			})),
		}));
		onOmpTurnLifecycle!('owned-session-ai-tab-a', { phase: 'turn_end' });

		const logs = storedSession().aiTabs[0].logs;
		expect(logs.map((log) => log.id)).toEqual([
			'first',
			'omp-turn-boundary:owned-session-ai-tab-a:20000:2',
			'queued',
			'second-output',
			'omp-turn-boundary:owned-session-ai-tab-a:21000:4',
		]);
		expect(logs.find((log) => log.id === 'queued')).toMatchObject({
			timestamp: 20_000,
			deliveryState: 'consumed',
		});
	});

	it('flushes OMP output and tool activity before lifecycle receipts and continuation output', () => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) => ({
				...session,
				toolType: 'omp',
				aiTabs: session.aiTabs.map((tab) =>
					tab.id === 'tab-a'
						? {
								...tab,
								showThinking: 'on',
								logs: [
									{ id: 'first', timestamp: 1, source: 'user', text: 'First request' },
									{
										id: 'queued',
										timestamp: 2,
										source: 'user',
										text: 'Follow-up request',
										deliveryIntent: 'follow_up',
										deliveryState: 'queued',
									},
								],
							}
						: tab
				),
			})),
		}));
		const { result } = renderHook(() => {
			const batchedUpdater = useBatchedSessionUpdates(60_000);
			const ompEventCoordinator = useOmpEventCoordinator(() =>
				batchedUpdater.flushSessionNow('owned-session')
			);
			const flushThinkingForSession = useAgentThinkingListener(ompEventCoordinator);
			useAgentToolExecutionListener(batchedUpdater, flushThinkingForSession, ompEventCoordinator);
			useRuntimeFeaturesListener(batchedUpdater, flushThinkingForSession, ompEventCoordinator);
			return batchedUpdater;
		});

		onThinkingChunk!('owned-session-ai-tab-a', 'First thinking');
		result.current.appendLog('owned-session', 'tab-a', true, 'First output');
		onToolExecution!('owned-session-ai-tab-a', {
			toolName: 'bash',
			toolCallId: 'first-tool',
			timestamp: 3,
			state: { status: 'completed' },
		});
		onOmpTurnLifecycle!('owned-session-ai-tab-a', { phase: 'turn_end' });
		onOmpTurnLifecycle!('owned-session-ai-tab-a', {
			phase: 'agent_start',
			continuation: true,
			deliveryIntent: 'follow_up',
			deliveryId: 'queued',
		});
		result.current.appendLog('owned-session', 'tab-a', true, 'Follow-up output');
		onOmpTurnLifecycle!('owned-session-ai-tab-a', { phase: 'turn_end' });

		const logs = storedSession().aiTabs[0].logs;
		expect(logs.map((log) => log.text)).toEqual([
			'First request',
			'First thinking',
			'First output',
			'bash',
			'',
			'Follow-up request',
			'Follow-up output',
			'',
		]);
		expect(logs.map((log) => log.source)).toEqual([
			'user',
			'thinking',
			'stdout',
			'tool',
			'system',
			'user',
			'stdout',
			'system',
		]);
		expect(logs[4]?.metadata?.ompTurnBoundary).toBe(true);
		expect(logs[7]?.metadata?.ompTurnBoundary).toBe(true);
	});

	it('ignores feature events for sessions this window does not own', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onRuntimeFeatures!('foreign-session-ai-tab-a', featureState('foreign'));

		const session = storedSession();
		expect(session.aiTabs[0].runtimeFeatures?.controls[0].label).toBe('seed-a');
	});
});
