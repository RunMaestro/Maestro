import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProgressPoll } from '../../../../renderer/hooks/batch/internal/batchProgressPoll';
import type { Session, BatchRunState } from '../../../../renderer/types';

const INTERVAL = 1000;

const stubReadDoc = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	stubReadDoc.mockReset();
	(window as unknown as { maestro: unknown }).maestro = {
		autorun: {
			readDoc: vi.fn(async () => ({ success: true, content: '' })),
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
});

const makePoll = (overrides: Partial<Parameters<typeof createProgressPoll>[0]> = {}) => {
	const updateBatchState = vi.fn<
		[
			string,
			(prev: Record<string, BatchRunState>) => Record<string, BatchRunState>,
			boolean | undefined,
		],
		void
	>();
	const onUpdateSession = vi.fn();
	const documents = [{ filename: 'a' }, { filename: 'b' }];
	const docEntry = { filename: 'a' };

	const poll = createProgressPoll({
		documents,
		docEntry,
		folderPath: '/p',
		sshRemoteId: undefined,
		sessionId: 'sess',
		intervalMs: INTERVAL,
		readDocAndCountTasks: stubReadDoc as never,
		updateBatchState,
		getSessions: () => [] as Session[],
		onUpdateSession,
		...overrides,
	});

	return { poll, updateBatchState, onUpdateSession };
};

describe('createProgressPoll', () => {
	it('start() schedules the first tick after intervalMs', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 2, checkedCount: 1, content: '' });
		const { poll, updateBatchState } = makePoll();

		await poll.start();
		expect(updateBatchState).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(stubReadDoc).toHaveBeenCalled();
		// updater receives an empty prev; the inner branch returns prev unchanged when
		// the new totals match the default state - so we only assert the call happened.
		expect(updateBatchState).toHaveBeenCalled();
	});

	it('start() awaits the baseline reads of the OTHER documents before scheduling', async () => {
		// Each document returns 1 unchecked + 1 checked = 2 total each.
		stubReadDoc.mockResolvedValue({ taskCount: 1, checkedCount: 1, content: '' });
		const { poll } = makePoll();

		await poll.start();
		// The baseline read happens for every doc except docEntry (docs has 2 entries).
		expect(stubReadDoc).toHaveBeenCalledWith('/p', 'b', undefined);
	});

	it('stop() cancels the pending tick', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
		const { poll, updateBatchState } = makePoll();

		await poll.start();
		poll.stop();

		await vi.advanceTimersByTimeAsync(INTERVAL * 2);
		// updateBatchState may have been called once during baseline if any tick had
		// already fired before stop() - but here stop() is called immediately, so no
		// tick should have fired yet.
		expect(updateBatchState).not.toHaveBeenCalled();
	});

	it('updateBatchState is a no-op (returns prev) when the polled totals match prev state', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
		const { poll, updateBatchState } = makePoll();

		await poll.start();
		await vi.advanceTimersByTimeAsync(INTERVAL);

		expect(updateBatchState).toHaveBeenCalled();
		const updater = updateBatchState.mock.calls[0][1];
		const prev = { sess: { totalTasksAcrossAllDocs: 0, completedTasksAcrossAllDocs: 0 } as never };
		expect(updater(prev)).toBe(prev);
	});

	it('emits an updated state when the polled totals change', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 5, checkedCount: 3, content: '' });
		const { poll, updateBatchState } = makePoll();

		await poll.start();
		await vi.advanceTimersByTimeAsync(INTERVAL);

		const updater = updateBatchState.mock.calls[0][1];
		const prev = {
			sess: {
				totalTasksAcrossAllDocs: 0,
				completedTasksAcrossAllDocs: 0,
				cumulativeTaskTimeMs: 0,
			} as never,
		};
		const next = updater(prev);
		expect(next.sess.totalTasksAcrossAllDocs).toBeGreaterThan(0);
		expect(next.sess.completedTasksAcrossAllDocs).toBeGreaterThan(0);
	});

	it('refreshes autoRunContent when the user is viewing a document and content changed', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
		const session = {
			id: 'sess',
			autoRunSelectedFile: 'view',
			autoRunContent: 'old',
			autoRunContentVersion: 0,
		} as unknown as Session;
		const readDoc = vi.fn(async () => ({ success: true, content: 'fresh' }));
		(window as unknown as { maestro: unknown }).maestro = { autorun: { readDoc } };

		const { poll, onUpdateSession } = makePoll({ getSessions: () => [session] });

		await poll.start();
		await vi.advanceTimersByTimeAsync(INTERVAL);

		expect(readDoc).toHaveBeenCalledWith('/p', 'view.md', undefined);
		expect(onUpdateSession).toHaveBeenCalledWith('sess', {
			autoRunContent: 'fresh',
			autoRunContentVersion: 1,
		});
	});

	it('does not call onUpdateSession when the polled content equals current content', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
		const session = {
			id: 'sess',
			autoRunSelectedFile: 'view',
			autoRunContent: 'same',
			autoRunContentVersion: 1,
		} as unknown as Session;
		const readDoc = vi.fn(async () => ({ success: true, content: 'same' }));
		(window as unknown as { maestro: unknown }).maestro = { autorun: { readDoc } };

		const { poll, onUpdateSession } = makePoll({ getSessions: () => [session] });

		await poll.start();
		await vi.advanceTimersByTimeAsync(INTERVAL);

		expect(onUpdateSession).not.toHaveBeenCalled();
	});

	it('swallows readDocAndCountTasks errors during a tick', async () => {
		stubReadDoc.mockRejectedValueOnce(new Error('boom'));
		const { poll, updateBatchState } = makePoll();

		await poll.start();
		await vi.advanceTimersByTimeAsync(INTERVAL);

		// No throw, no update.
		expect(updateBatchState).not.toHaveBeenCalled();
	});

	it('reschedules itself on the next interval after a successful tick', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
		const { poll } = makePoll();

		await poll.start();
		await vi.advanceTimersByTimeAsync(INTERVAL);
		const callsAfterFirst = stubReadDoc.mock.calls.length;

		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(stubReadDoc.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});

	it('restart() is supported and re-arms a new schedule after stop', async () => {
		stubReadDoc.mockResolvedValue({ taskCount: 0, checkedCount: 0, content: '' });
		const { poll } = makePoll();

		await poll.start();
		poll.stop();
		await poll.restart();

		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(stubReadDoc).toHaveBeenCalled();
	});
});
