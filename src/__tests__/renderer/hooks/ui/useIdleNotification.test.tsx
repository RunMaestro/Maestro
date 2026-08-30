import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIdleNotification } from '../../../../renderer/hooks/ui/useIdleNotification';
import {
	useSessionStore,
	selectHasAnyRunnableQueuedWork,
} from '../../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { createMockSession } from '../../../helpers/mockSession';
import type { QueuedItem, Session } from '../../../../renderer/types';

/**
 * The idle notification must stay quiet while an agent still has work that
 * would actually run. `busy` alone is only true while a turn is in flight, and
 * the dequeue is atomic, so a draining queue leaves the agent genuinely `idle`
 * in the gap between two queued turns - which is where it used to announce
 * "Maestro is idle" once per gap.
 */

const speak = vi.fn().mockResolvedValue(undefined);

function queuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q1',
		timestamp: 1,
		tabId: 'tab-1',
		type: 'message',
		text: 'do the thing',
		...overrides,
	};
}

function setSessions(sessions: Session[]): void {
	useSessionStore.setState({ sessions });
}

describe('useIdleNotification', () => {
	beforeEach(() => {
		speak.mockClear();
		(globalThis as unknown as { window: Record<string, unknown> }).window.maestro = {
			notification: { speak },
		};
		useBatchStore.setState({ batchRunStates: {} });
		useNotificationStore.getState().setIdleNotification(true, 'say Maestro is idle');
		setSessions([]);
	});

	describe('selectHasAnyRunnableQueuedWork', () => {
		it('counts an idle agent with a runnable queued item as having work', () => {
			const state = {
				sessions: [createMockSession({ state: 'idle', executionQueue: [queuedItem()] })],
			};
			expect(selectHasAnyRunnableQueuedWork(state as never)).toBe(true);
		});

		it('does not count a queue holding only paused items', () => {
			const state = {
				sessions: [
					createMockSession({
						state: 'idle',
						executionQueue: [queuedItem({ paused: true }), queuedItem({ id: 'q2', paused: true })],
					}),
				],
			};
			expect(selectHasAnyRunnableQueuedWork(state as never)).toBe(false);
		});

		it('counts a mixed queue, because one item would still run', () => {
			const state = {
				sessions: [
					createMockSession({
						state: 'idle',
						executionQueue: [queuedItem({ paused: true }), queuedItem({ id: 'q2' })],
					}),
				],
			};
			expect(selectHasAnyRunnableQueuedWork(state as never)).toBe(true);
		});

		it('tolerates a session with no queue field at all', () => {
			const session = createMockSession({ state: 'idle' });
			delete (session as Partial<Session>).executionQueue;
			expect(selectHasAnyRunnableQueuedWork({ sessions: [session] } as never)).toBe(false);
		});
	});

	it('stays silent in the gap between two queued turns', () => {
		// Turn 1 running, with the next item still queued behind it.
		setSessions([createMockSession({ state: 'busy', executionQueue: [queuedItem({ id: 'q2' })] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		// Turn 1 ends. The session is idle but q2 has not been dispatched yet -
		// this is the window that used to fire.
		setSessions([createMockSession({ state: 'idle', executionQueue: [queuedItem({ id: 'q2' })] })]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('fires once when the last queued item finishes and the queue is empty', () => {
		setSessions([createMockSession({ state: 'busy', executionQueue: [] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(speak).toHaveBeenCalledTimes(1);
		expect(speak).toHaveBeenCalledWith('Maestro is idle', 'say Maestro is idle');

		// Still idle on a later render - the edge already fired, so it must not repeat.
		rerender();
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('fires when the only queued items are paused, because they can never start', () => {
		setSessions([
			createMockSession({ state: 'busy', executionQueue: [queuedItem({ paused: true })] }),
		]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessions([
			createMockSession({ state: 'idle', executionQueue: [queuedItem({ paused: true })] }),
		]);
		rerender();

		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('speaks only after the whole queue drains, not once per item', () => {
		const drain: Array<{ state: Session['state']; queue: QueuedItem[] }> = [
			{ state: 'busy', queue: [queuedItem({ id: 'q2' }), queuedItem({ id: 'q3' })] },
			{ state: 'idle', queue: [queuedItem({ id: 'q2' }), queuedItem({ id: 'q3' })] },
			{ state: 'busy', queue: [queuedItem({ id: 'q3' })] },
			{ state: 'idle', queue: [queuedItem({ id: 'q3' })] },
			{ state: 'busy', queue: [] },
			{ state: 'idle', queue: [] },
		];

		setSessions([createMockSession({ state: 'busy', executionQueue: drain[0].queue })]);
		const { rerender } = renderHook(() => useIdleNotification());

		for (const step of drain) {
			setSessions([createMockSession({ state: step.state, executionQueue: step.queue })]);
			rerender();
		}

		// Three turns, two intermediate gaps, exactly one announcement.
		expect(speak).toHaveBeenCalledTimes(1);
	});

	it('does not fire while an Auto Run batch is still running', () => {
		setSessions([createMockSession({ state: 'busy', executionQueue: [] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		useBatchStore.setState({
			batchRunStates: { 'session-1': { isRunning: true } as never },
		});
		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('stays silent when the notification is disabled', () => {
		useNotificationStore.getState().setIdleNotification(false, 'say Maestro is idle');
		setSessions([createMockSession({ state: 'busy', executionQueue: [] })]);
		const { rerender } = renderHook(() => useIdleNotification());

		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		rerender();

		expect(speak).not.toHaveBeenCalled();
	});

	it('does not fire on mount when already idle', () => {
		setSessions([createMockSession({ state: 'idle', executionQueue: [] })]);
		renderHook(() => useIdleNotification());

		expect(speak).not.toHaveBeenCalled();
	});
});
