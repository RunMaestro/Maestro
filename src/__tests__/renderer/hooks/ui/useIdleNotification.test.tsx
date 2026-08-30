/**
 * Tests for useIdleNotification.
 *
 * The rule under test: announce idle only when there is genuinely nothing left
 * to do. "No turn in flight" is NOT the same question - the exit reducer parks
 * an agent at `state: 'idle'` while holding its queue whenever a retry is
 * counting down, so a busy -> idle edge can happen with a dozen messages still
 * lined up. A paused item is waiting on the user rather than on us, so a queue
 * holding only paused items is genuinely finished and must still announce.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useIdleNotification } from '../../../../renderer/hooks/ui/useIdleNotification';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { QueuedItem, Session } from '../../../../renderer/types';

const speak = vi.fn().mockResolvedValue(undefined);

function queuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q-1',
		timestamp: 1700000000000,
		tabId: 'tab-1',
		type: 'message',
		text: 'do the thing',
		...overrides,
	} as QueuedItem;
}

/** Put a single agent in the store with the given state and queue. */
function setSession(state: Session['state'], executionQueue: QueuedItem[] = []): void {
	useSessionStore.setState({
		sessions: [createMockSession({ id: 'sess-1', state, executionQueue })],
	});
}

beforeEach(() => {
	speak.mockClear();
	(globalThis as any).window.maestro = {
		...((globalThis as any).window.maestro ?? {}),
		notification: { speak },
	};

	useSessionStore.setState({ sessions: [] });
	useBatchStore.setState({ batches: {} } as any);
	useNotificationStore.setState((s) => ({
		config: {
			...s.config,
			idleNotificationEnabled: true,
			idleNotificationCommand: 'say Maestro is idle',
		},
	}));
});

describe('useIdleNotification', () => {
	it('does not announce idle while an agent still has runnable queued work', () => {
		setSession('busy', [queuedItem()]);
		const { rerender } = renderHook(() => useIdleNotification());

		// Turn ends, but the queue is held (a retry is counting down). The agent
		// is genuinely idle and genuinely not finished.
		act(() => setSession('idle', [queuedItem()]));
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('announces idle when the queue holds only paused items', () => {
		setSession('busy', [queuedItem({ paused: true })]);
		const { rerender } = renderHook(() => useIdleNotification());

		act(() => setSession('idle', [queuedItem({ paused: true })]));
		rerender();

		// A held item waits on the user, so this agent really is done.
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('announces once on the busy -> idle edge with an empty queue', () => {
		setSession('busy', []);
		const { rerender } = renderHook(() => useIdleNotification());

		act(() => setSession('idle', []));
		rerender();
		expect(speak).toHaveBeenCalledTimes(1);

		// Staying idle must not re-announce - it fires on the edge, not the level.
		act(() => setSession('idle', []));
		rerender();
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('announces when the queue drains down to only paused items', () => {
		setSession('busy', [queuedItem(), queuedItem({ id: 'q-2', paused: true })]);
		const { rerender } = renderHook(() => useIdleNotification());

		// The runnable item is still queued: silent.
		act(() => setSession('idle', [queuedItem(), queuedItem({ id: 'q-2', paused: true })]));
		rerender();
		expect(speak).not.toHaveBeenCalled();

		// It ran and left only the held one behind: now we are done.
		act(() => setSession('idle', [queuedItem({ id: 'q-2', paused: true })]));
		rerender();
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('stays silent when another agent still has queued work', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'sess-1', state: 'busy', executionQueue: [] }),
				createMockSession({ id: 'sess-2', state: 'idle', executionQueue: [queuedItem()] }),
			],
		});
		const { rerender } = renderHook(() => useIdleNotification());

		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'sess-1', state: 'idle', executionQueue: [] }),
				createMockSession({ id: 'sess-2', state: 'idle', executionQueue: [queuedItem()] }),
			],
		});
		act(() => {});
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('does not announce when the setting is disabled', () => {
		useNotificationStore.setState((s) => ({
			config: { ...s.config, idleNotificationEnabled: false },
		}));
		setSession('busy', []);
		const { rerender } = renderHook(() => useIdleNotification());

		act(() => setSession('idle', []));
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});
});
