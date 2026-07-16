import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentSessionIdListener } from '../../../../../renderer/hooks/agent/internal/useAgentSessionIdListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';

let handler: ((sessionId: string, agentSessionId: string) => Promise<void>) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onSessionId: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

function makeBatched(): BatchedUpdater {
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
	useSessionStore.setState({
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

	it('adopts an OMP session id returned by an explicit native session switch', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'native-before-switch',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'omp',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handler!('sess-1-ai-tab-1', 'native-after-switch');

		expect(batched.updateContextUsage).not.toHaveBeenCalled();
		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('native-after-switch');
		expect(updated.aiTabs[0].logs.some((log) => log.text.includes('resume failed'))).toBe(false);
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
		expect(setSessionsSpy).toHaveBeenCalled(); // setSessions is still invoked, but the inner reducer returns prev unchanged.
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toEqual([]);
	});
});
