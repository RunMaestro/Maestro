import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentDataListener } from '../../../../../renderer/hooks/agent/internal/useAgentDataListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';

let handler: ((sessionId: string, data: string) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onData: vi.fn((h: any) => {
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

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
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
		agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('useAgentDataListener', () => {
	it('routes ai-formatted ids through batched appendLog with isAi=true', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handler!('sess-1-ai-tab-1', 'hello\n');

		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'hello\n');
		expect(batched.markDelivered).toHaveBeenCalledWith('sess-1', 'tab-1');
		expect(batched.updateCycleBytes).toHaveBeenCalledWith('sess-1', 6);
	});

	it('routes plain session ids as terminal output', () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handler!('sess-1', 'terminal output');
		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', null, false, 'terminal output');
		expect(batched.markDelivered).not.toHaveBeenCalled();
	});

	it('drops empty terminal output', () => {
		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handler!('sess-1', '   ');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});

	it('ignores -terminal and -batch- session ids', () => {
		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);

		handler!('sess-1-terminal', 'data');
		handler!('sess-1-batch-x', 'data');
		expect(batched.appendLog).not.toHaveBeenCalled();
	});

	it('deletes the matching activeHiddenToolRef entry on first chunk', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		const ref = makeRef();
		ref.current.set('sess-1:tab-1', { toolName: 'Read' });
		const batched = makeBatched();

		renderHook(() => useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: ref }));

		handler!('sess-1-ai-tab-1', 'data');
		expect(ref.current.has('sess-1:tab-1')).toBe(false);
	});

	it('clears lingering session.agentError on next data chunk', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			agentError: { type: 'auth_expired', message: 'expired', timestamp: 0 } as any,
			state: 'error',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: makeRef() })
		);
		handler!('sess-1-ai-tab-1', 'data');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.agentError).toBeUndefined();
		expect(updated.state).toBe('busy');
	});
});
