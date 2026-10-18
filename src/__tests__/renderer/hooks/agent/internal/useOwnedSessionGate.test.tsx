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
import { act, renderHook } from '@testing-library/react';

// Controlled WindowContext: `null` => no window scoping (permit all); an object
// with `ownsSession` => scope to that predicate. Mutated per-test.
let mockOwnsSession: ((id: string) => boolean) | undefined;
vi.mock('../../../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => (mockOwnsSession ? { ownsSession: mockOwnsSession } : null),
}));
let mockIsWebDesktop = false;
vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => mockIsWebDesktop,
}));

import {
	useOwnedSessionGate,
	useOwnedSideEffectGate,
	agentIdFromProcessSessionId,
} from '../../../../../renderer/hooks/agent/internal/useOwnedSessionGate';
import { useAgentDataListener } from '../../../../../renderer/hooks/agent/internal/useAgentDataListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import { useBatchedSessionUpdates } from '../../../../../renderer/hooks/session/useBatchedSessionUpdates';

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

describe('useOwnedSideEffectGate', () => {
	beforeEach(() => {
		mockOwnsSession = undefined;
		mockIsWebDesktop = false;
	});

	it('follows the ownership gate in the Electron renderer', () => {
		mockOwnsSession = (id: string) => id === 'agent-1';
		const { result } = renderHook(() => useOwnedSideEffectGate());

		expect(result.current.current?.('agent-1-ai-tab-1')).toBe(true);
		expect(result.current.current?.('agent-2-ai-tab-1')).toBe(false);
	});

	it('permits everything in the Electron renderer without a WindowProvider', () => {
		const { result } = renderHook(() => useOwnedSideEffectGate());
		expect(result.current.current?.('agent-1-ai-tab-1')).toBe(true);
	});

	it('denies every agent on a web-desktop client, even one the ownership gate permits', () => {
		mockIsWebDesktop = true;
		mockOwnsSession = () => true;
		const { result } = renderHook(() => useOwnedSideEffectGate());

		expect(result.current.current?.('agent-1-ai-tab-1')).toBe(false);
		expect(result.current.current?.('agent-1-terminal')).toBe(false);
	});

	it('denies before its effect commits on a web-desktop client', () => {
		mockIsWebDesktop = true;
		// The initial ref value is what the very first event sees.
		const { result } = renderHook(() => useOwnedSideEffectGate());
		expect(result.current.current?.('agent-1')).toBe(false);
	});
});

describe('useAgentDataListener window scoping', () => {
	let handler: ((sessionId: string, data: string) => void) | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		handler = undefined;
		mockIsWebDesktop = false;
		mockOwnsSession = (id) => id === 'sess-1';
		useSessionStore.setState({ sessions: [], activeSessionId: '', initialLoadComplete: false });
		window.maestro.process.onData = vi.fn((callback) => {
			handler = callback;
			return () => {};
		});
	});

	it.each([
		{ sessionId: 'sess-1', expected: [{ source: 'stdout', text: 'hello' }] },
		{ sessionId: 'sess-2', expected: [] },
	])(
		'keeps transcript output scoped to the owning window ($sessionId)',
		({ sessionId, expected }) => {
			const tab = createMockAITab({ id: 'tab-1', logs: [] });
			const session = createMockSession({ id: sessionId, aiTabs: [tab], activeTabId: 'tab-1' });
			useSessionStore.setState({ sessions: [session] });
			const { result } = renderHook(() => {
				const batched = useBatchedSessionUpdates();
				useAgentDataListener({
					batchedUpdater: batched,
					activeHiddenToolRef: { current: new Map() },
				});
				return batched;
			});

			act(() => {
				handler!(sessionId + '-ai-tab-1', 'hello');
				result.current.flushNow();
			});
			expect(
				useSessionStore
					.getState()
					.sessions[0].aiTabs[0].logs.map(({ source, text }) => ({ source, text }))
			).toEqual(expected);
		}
	);
});
