/**
 * Tests for useSessionLifecycleSync.
 *
 * Every client - each desktop window, every web-desktop browser tab - keeps its
 * own session tree and flushes it into one shared store, so main pushes the
 * agents that entered and left (`sessions:lifecycleSync`) and this hook applies
 * that delta locally. Without it an agent created in the browser never showed up
 * on the desktop, and one closed in the browser came back the moment the
 * desktop's stale copy was written again (issues #1398 / #1492).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSessionLifecycleSync } from '../../../../renderer/hooks/session/useSessionLifecycleSync';
import type { Session } from '../../../../renderer/types';
import { createMockSession, resetStore } from '../../../helpers';

type Payload = { added?: Session[]; removedIds?: string[] };

describe('useSessionLifecycleSync', () => {
	let handler: ((payload: Payload) => void) | null;
	let unsubscribe: ReturnType<typeof vi.fn>;
	let setActiveSessionId: ReturnType<typeof vi.fn>;
	// Stands in for the startup restore pass: tags the session so the test can
	// prove an agent from a peer went through the same preparation as a disk load.
	const restoreSession = vi.fn(async (s: Session) => ({ ...s, name: `${s.name} (restored)` }));

	beforeEach(() => {
		resetStore(useSessionStore);
		// Every test but the mid-load one acts on a client that has finished
		// loading; the hook deliberately holds deltas until then.
		useSessionStore.setState({ initialLoadComplete: true });
		handler = null;
		unsubscribe = vi.fn();
		setActiveSessionId = vi.fn();
		restoreSession.mockClear();
		(window as unknown as { maestro: unknown }).maestro = {
			sessions: {
				onLifecycleSync: (cb: (payload: Payload) => void) => {
					handler = cb;
					return unsubscribe;
				},
				setActiveSessionId,
			},
		};
	});

	it('adds an agent another client created', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'local' })],
			activeSessionId: 'local',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ added: [createMockSession({ id: 'from-web', name: 'Web agent' })] });

		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['local', 'from-web']);
		});
		// Restored, not spliced in raw - migrations and runtime resets still apply.
		const added = useSessionStore.getState().sessions.find((s) => s.id === 'from-web')!;
		expect(added.name).toBe('Web agent (restored)');
	});

	it('drops an agent another client closed', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ removedIds: ['b'] });

		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a']);
		});
	});

	it('re-points the focused agent when the closed one was on screen', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })],
			activeSessionId: 'b',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ removedIds: ['b'] });

		await waitFor(() => {
			expect(useSessionStore.getState().activeSessionId).toBe('a');
		});
	});

	it('ignores a delta it has already applied', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		// The push reaches the client that wrote it too (the web bridge has no
		// per-client identity), so both halves must be no-ops there.
		handler!({ added: [createMockSession({ id: 'a' })], removedIds: ['already-gone'] });

		await waitFor(() => {
			expect(restoreSession).not.toHaveBeenCalled();
		});
		expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a']);
	});

	it('applies additions and removals arriving in one delta', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ added: [createMockSession({ id: 'c' })], removedIds: ['b'] });

		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'c']);
		});
	});

	it('puts back the busy indicators for an agent that arrived mid-turn', async () => {
		const reattach = vi.fn();
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession, reattach));
		handler!({ added: [createMockSession({ id: 'busy-one' })] });

		await waitFor(() => expect(reattach).toHaveBeenCalledTimes(1));
	});

	it('does not probe for live turns when only a removal arrived', async () => {
		const reattach = vi.fn();
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession, reattach));
		handler!({ removedIds: ['b'] });

		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a']);
		});
		expect(reattach).not.toHaveBeenCalled();
	});

	it('waits for the startup load before applying a delta', async () => {
		// The load ends in one setSessions() that replaces the whole array, so a
		// delta applied before it would simply be overwritten - and a removal
		// undone that way gets flushed back to disk.
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			initialLoadComplete: false,
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ added: [createMockSession({ id: 'from-web' })] });

		await Promise.resolve();
		expect(useSessionStore.getState().sessions).toEqual([]);

		// The load lands, then the queued delta applies on top of it.
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'from-disk' })],
			initialLoadComplete: true,
		});

		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([
				'from-disk',
				'from-web',
			]);
		});
	});

	it('applies deltas in arrival order, so a close cannot overtake its add', async () => {
		// Without the queue, the close for 'short-lived' arrives while the add is
		// still restoring, reads the agent as one this client never had, and drops
		// itself - then the add commits the agent the user just closed.
		let releaseRestore: (() => void) | null = null;
		restoreSession.mockImplementationOnce(async (session: Session) => {
			await new Promise<void>((resolve) => {
				releaseRestore = resolve;
			});
			return session;
		});
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ added: [createMockSession({ id: 'short-lived' })] });
		await waitFor(() => expect(releaseRestore).not.toBeNull());
		handler!({ removedIds: ['short-lived'] });

		releaseRestore!();

		// Let BOTH deltas settle before asserting: the interesting state is the one
		// after the add has committed, since an unordered pair leaves the closed
		// agent behind exactly then.
		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain('a');
			expect(restoreSession).toHaveBeenCalledTimes(1);
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a']);
	});

	it('keeps following its peers after one delta fails', async () => {
		restoreSession.mockRejectedValueOnce(new Error('restore blew up'));
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' })],
			activeSessionId: 'a',
		});

		renderHook(() => useSessionLifecycleSync(restoreSession));
		handler!({ added: [createMockSession({ id: 'doomed' })] });
		handler!({ added: [createMockSession({ id: 'later' })] });

		await waitFor(() => {
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['a', 'later']);
		});
	});

	it('unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useSessionLifecycleSync(restoreSession));
		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('does nothing when the bridge predates the channel', () => {
		(window as unknown as { maestro: unknown }).maestro = { sessions: {} };
		expect(() => renderHook(() => useSessionLifecycleSync(restoreSession))).not.toThrow();
	});
});
