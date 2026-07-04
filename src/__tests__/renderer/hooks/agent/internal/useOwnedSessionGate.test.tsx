/**
 * Tests for window-scoped process-event filtering (Phase 5).
 *
 * Covers:
 *  - `agentIdFromProcessSessionId` - resolving the owning agent id from every
 *    decorated `process:*` session id shape.
 *  - `useOwnedSessionGate` - the stable ref predicate, including the null-safe
 *    (no WindowProvider) path.
 *  - A representative end-to-end filter: `useAgentDataListener` drops events for
 *    agents this window does not own, and processes events for agents it owns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Controlled WindowContext: `null` => no window scoping (permit all); an object
// with `ownsSession` => scope to that predicate. Mutated per-test.
let mockOwnsSession: ((id: string) => boolean) | undefined;
vi.mock('../../../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => (mockOwnsSession ? { ownsSession: mockOwnsSession } : null),
}));

import {
	useOwnedSessionGate,
	agentIdFromProcessSessionId,
} from '../../../../../renderer/hooks/agent/internal/useOwnedSessionGate';
import { useAgentDataListener } from '../../../../../renderer/hooks/agent/internal/useAgentDataListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';

describe('agentIdFromProcessSessionId', () => {
	it('strips the -ai-{tabId} suffix', () => {
		expect(agentIdFromProcessSessionId('agent-1-ai-tab-7')).toBe('agent-1');
	});

	it('strips the -terminal suffix', () => {
		expect(agentIdFromProcessSessionId('agent-1-terminal')).toBe('agent-1');
	});

	it('resolves batch/synopsis ids to the parent agent', () => {
		expect(agentIdFromProcessSessionId('agent-1-batch-1700000000000')).toBe('agent-1');
		expect(agentIdFromProcessSessionId('agent-1-synopsis-1700000000000')).toBe('agent-1');
	});

	it('passes a bare agent id through unchanged', () => {
		expect(agentIdFromProcessSessionId('agent-1')).toBe('agent-1');
	});
});

describe('useOwnedSessionGate', () => {
	beforeEach(() => {
		mockOwnsSession = undefined;
	});

	it('permits everything when there is no WindowProvider (null-safe)', () => {
		mockOwnsSession = undefined;
		const { result } = renderHook(() => useOwnedSessionGate());

		expect(result.current.current?.('agent-1-ai-tab-1')).toBe(true);
		expect(result.current.current?.('anything-at-all')).toBe(true);
	});

	it('permits raw ids whose owning agent this window owns', () => {
		mockOwnsSession = (id: string) => id === 'agent-1';
		const { result } = renderHook(() => useOwnedSessionGate());

		expect(result.current.current?.('agent-1-ai-tab-1')).toBe(true);
		expect(result.current.current?.('agent-1-terminal')).toBe(true);
		expect(result.current.current?.('agent-1-batch-1700000000000')).toBe(true);
	});

	it('rejects raw ids whose owning agent lives in another window', () => {
		mockOwnsSession = (id: string) => id === 'agent-1';
		const { result } = renderHook(() => useOwnedSessionGate());

		expect(result.current.current?.('agent-2-ai-tab-1')).toBe(false);
		expect(result.current.current?.('agent-2-terminal')).toBe(false);
		expect(result.current.current?.('agent-2')).toBe(false);
	});

	it('returns a STABLE ref across re-renders (so listeners never re-subscribe)', () => {
		mockOwnsSession = () => true;
		const { result, rerender } = renderHook(() => useOwnedSessionGate());
		const firstRef = result.current;
		rerender();
		expect(result.current).toBe(firstRef);
	});
});

describe('useAgentDataListener window scoping', () => {
	let handler: ((sessionId: string, data: string) => void) | undefined;
	const mockUnsubscribe = vi.fn();

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
		mockOwnsSession = undefined;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		} as never);
		(window as unknown as { maestro: unknown }).maestro = {
			...((window as unknown as { maestro?: Record<string, unknown> }).maestro || {}),
			process: {
				onData: vi.fn((h: (sessionId: string, data: string) => void) => {
					handler = h;
					return mockUnsubscribe;
				}),
			},
			agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
		};
	});

	it('processes data for an agent THIS window owns', () => {
		mockOwnsSession = (id: string) => id === 'sess-1';
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab], activeTabId: 'tab-1' });
		useSessionStore.setState({ sessions: [session] } as never);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: { current: new Map() } })
		);

		handler!('sess-1-ai-tab-1', 'hello\n');

		expect(batched.appendLog).toHaveBeenCalledWith('sess-1', 'tab-1', true, 'hello\n');
	});

	it('drops data for an agent owned by ANOTHER window', () => {
		mockOwnsSession = (id: string) => id === 'sess-1';
		const tab = createMockAITab({ id: 'tab-9' });
		// sess-2 exists in this window's store (Left Bar shows all agents) but is
		// owned by another window, so its output must NOT be appended here.
		const otherSession = createMockSession({ id: 'sess-2', aiTabs: [tab], activeTabId: 'tab-9' });
		useSessionStore.setState({ sessions: [otherSession] } as never);

		const batched = makeBatched();
		renderHook(() =>
			useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: { current: new Map() } })
		);

		handler!('sess-2-ai-tab-9', 'hidden\n');

		expect(batched.appendLog).not.toHaveBeenCalled();
		expect(batched.markDelivered).not.toHaveBeenCalled();
	});
});
