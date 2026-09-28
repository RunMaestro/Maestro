/**
 * Tests for prCreationStore - the `gh pr create` request that outlives its form.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePRCreationStore, prRunKey } from '../../../renderer/stores/prCreationStore';

const TARGET = {
	sessionId: 'session-1',
	worktreePath: '/test/worktree',
	sourceBranch: 'visual-polish',
	targetBranch: 'main',
	title: 'visual polish',
	description: '',
};
const KEY = prRunKey(TARGET.worktreePath);

type CreatePRResult = { success: boolean; prUrl?: string; error?: string };

let settle: (result: CreatePRResult) => void = () => {};
let reject: (err: Error) => void = () => {};
const createPR = vi.fn();

describe('prCreationStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usePRCreationStore.setState({ runs: {} });
		createPR.mockImplementation(
			() =>
				new Promise<CreatePRResult>((resolve, rejectFn) => {
					settle = resolve;
					reject = rejectFn;
				})
		);
		(globalThis as unknown as { window: { maestro: unknown } }).window.maestro = {
			git: { createPR },
		};
	});

	it('records a running attempt keyed by repo path', () => {
		usePRCreationStore.getState().startPRCreation(TARGET);

		expect(createPR).toHaveBeenCalledWith('/test/worktree', 'main', 'visual polish', '');
		expect(usePRCreationStore.getState().runs[KEY]).toMatchObject({
			status: 'running',
			sessionId: 'session-1',
			sourceBranch: 'visual-polish',
		});
	});

	it('folds the PR url back into the run', async () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		settle({ success: true, prUrl: 'https://github.com/o/r/pull/7' });
		await vi.waitFor(() => expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('success'));
		expect(usePRCreationStore.getState().runs[KEY]?.prUrl).toBe('https://github.com/o/r/pull/7');
	});

	it('records a rejected call as a failure rather than losing it', async () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		reject(new Error('gh exploded'));
		await vi.waitFor(() => expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed'));
		expect(usePRCreationStore.getState().runs[KEY]?.error).toBe('gh exploded');
	});

	it('treats a second attempt on the same repo as a re-attach, not a duplicate PR', () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		usePRCreationStore.getState().startPRCreation({ ...TARGET, title: 'different title' });

		expect(createPR).toHaveBeenCalledTimes(1);
		expect(usePRCreationStore.getState().runs[KEY]?.title).toBe('visual polish');
	});

	it('lets a settled attempt be retried', async () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		settle({ success: false, error: 'no commits between branches' });
		await vi.waitFor(() => expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed'));

		usePRCreationStore.getState().startPRCreation({ ...TARGET, title: 'second go' });

		expect(createPR).toHaveBeenCalledTimes(2);
		expect(usePRCreationStore.getState().runs[KEY]).toMatchObject({
			status: 'running',
			title: 'second go',
		});
		// The previous failure must not survive into the new attempt.
		expect(usePRCreationStore.getState().runs[KEY]?.error).toBeUndefined();
	});

	it('drops a result whose run was cleared while it was in flight', async () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		usePRCreationStore.getState().clearRun(KEY);
		settle({ success: true, prUrl: 'https://github.com/o/r/pull/7' });

		await Promise.resolve();
		expect(usePRCreationStore.getState().runs[KEY]).toBeUndefined();
	});

	it('announces a settlement only once', async () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		settle({ success: false, error: 'boom' });
		await vi.waitFor(() => expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed'));

		usePRCreationStore.getState().markAnnounced(KEY);
		expect(usePRCreationStore.getState().runs[KEY]?.announced).toBe(true);
	});
});
