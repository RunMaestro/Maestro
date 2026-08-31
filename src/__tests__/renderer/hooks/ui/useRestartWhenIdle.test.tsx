import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRestartWhenIdle } from '../../../../renderer/hooks/ui/useRestartWhenIdle';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useRestartPendingStore } from '../../../../renderer/stores/restartPendingStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { QueuedItem, Session } from '../../../../renderer/types';

/**
 * This hook shares its activity definition with `useIdleNotification`, but
 * where that one speaks, this one calls `updates.install()` and relaunches the
 * app. So the gap between two queued turns is not a cosmetic problem here: a
 * restart fired in that window takes the app down with queued work still in the
 * queue.
 */

const install = vi.fn().mockResolvedValue(undefined);

function queuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return { id: 'q1', timestamp: 1, tabId: 'tab-1', type: 'message', text: 'go', ...overrides };
}

function setSessions(sessions: Session[]): void {
	useSessionStore.setState({ sessions });
}

describe('useRestartWhenIdle', () => {
	beforeEach(() => {
		install.mockClear();
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			updates: { install },
		};
		useBatchStore.setState({ batchRunStates: {} });
		useRestartPendingStore.setState({ pending: false });
		setSessions([]);
	});

	it('does not restart in the gap between two queued turns', () => {
		setSessions([createMockSession({ state: 'busy', executionQueue: [queuedItem({ id: 'q2' })] })]);
		useRestartPendingStore.setState({ pending: true });
		const { rerender } = renderHook(() => useRestartWhenIdle());

		// Turn ends, next item still queued. A restart here would kill queued work.
		setSessions([createMockSession({ state: 'idle', executionQueue: [queuedItem({ id: 'q2' })] })]);
		rerender();

		expect(install).not.toHaveBeenCalled();
		expect(useRestartPendingStore.getState().pending).toBe(true);
	});

	it('restarts once the queue is genuinely drained', () => {
		setSessions([createMockSession({ state: 'busy', executionQueue: [queuedItem({ id: 'q2' })] })]);
		useRestartPendingStore.setState({ pending: true });
		const { rerender } = renderHook(() => useRestartWhenIdle());

		setSessions([createMockSession({ state: 'idle', executionQueue: [queuedItem({ id: 'q2' })] })]);
		rerender();
		expect(install).not.toHaveBeenCalled();

		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(install).toHaveBeenCalledTimes(1);
		expect(useRestartPendingStore.getState().pending).toBe(false);
	});

	it('restarts when the queue holds only paused items', () => {
		setSessions([
			createMockSession({ state: 'idle', executionQueue: [queuedItem({ paused: true })] }),
		]);
		useRestartPendingStore.setState({ pending: true });
		renderHook(() => useRestartWhenIdle());

		expect(install).toHaveBeenCalledTimes(1);
	});

	it('does nothing while no restart is pending', () => {
		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		renderHook(() => useRestartWhenIdle());

		expect(install).not.toHaveBeenCalled();
	});
});
