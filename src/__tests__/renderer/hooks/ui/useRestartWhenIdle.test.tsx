/**
 * Tests for useRestartWhenIdle.
 *
 * This hook reads the SAME activity selectors as useIdleNotification, which is
 * the point: the two must not drift on what "idle" means. The stakes are higher
 * here - announcing idle over a full queue is annoying, restarting the app out
 * from under one throws the queued work away.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useRestartWhenIdle } from '../../../../renderer/hooks/ui/useRestartWhenIdle';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useRestartPendingStore } from '../../../../renderer/stores/restartPendingStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { QueuedItem, Session } from '../../../../renderer/types';

const install = vi.fn();

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

function setSession(state: Session['state'], executionQueue: QueuedItem[] = []): void {
	useSessionStore.setState({
		sessions: [createMockSession({ id: 'sess-1', state, executionQueue })],
	});
}

beforeEach(() => {
	install.mockClear();
	(globalThis as any).window.maestro = {
		...((globalThis as any).window.maestro ?? {}),
		updates: { install },
	};

	useSessionStore.setState({ sessions: [] });
	useBatchStore.setState({ batches: {} } as any);
	useRestartPendingStore.setState({ pending: true });
});

describe('useRestartWhenIdle', () => {
	it('does not restart while an agent still has runnable queued work', () => {
		setSession('busy', [queuedItem()]);
		const { rerender } = renderHook(() => useRestartWhenIdle());

		act(() => setSession('idle', [queuedItem()]));
		rerender();

		expect(install).not.toHaveBeenCalled();
		// The pending flag must survive, or the deferred restart is silently lost.
		expect(useRestartPendingStore.getState().pending).toBe(true);
	});

	it('restarts when the queue holds only paused items', () => {
		setSession('busy', [queuedItem({ paused: true })]);
		const { rerender } = renderHook(() => useRestartWhenIdle());

		act(() => setSession('idle', [queuedItem({ paused: true })]));
		rerender();

		expect(install).toHaveBeenCalledTimes(1);
	});

	it('restarts on the busy -> idle edge with an empty queue', () => {
		setSession('busy', []);
		const { rerender } = renderHook(() => useRestartWhenIdle());

		act(() => setSession('idle', []));
		rerender();

		expect(install).toHaveBeenCalledTimes(1);
	});

	it('does not restart when no update is pending', () => {
		useRestartPendingStore.setState({ pending: false });
		setSession('busy', []);
		const { rerender } = renderHook(() => useRestartWhenIdle());

		act(() => setSession('idle', []));
		rerender();

		expect(install).not.toHaveBeenCalled();
	});
});
