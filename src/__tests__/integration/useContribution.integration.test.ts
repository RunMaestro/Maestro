import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useContribution } from '../../renderer/hooks/symphony/useContribution';
import type { ActiveContribution } from '../../shared/symphony-types';

type ContributionOverrides = Partial<Omit<ActiveContribution, 'progress' | 'tokenUsage'>> & {
	progress?: Partial<ActiveContribution['progress']>;
	tokenUsage?: Partial<ActiveContribution['tokenUsage']>;
};

function createContribution(overrides: ContributionOverrides = {}): ActiveContribution {
	return {
		id: 'contribution-1',
		repoSlug: 'owner/repo',
		repoName: 'Repo',
		issueNumber: 42,
		issueTitle: 'Improve docs',
		localPath: '/tmp/repo',
		branchName: 'symphony/issue-42',
		draftPrNumber: 7,
		draftPrUrl: 'https://github.com/owner/repo/pull/7',
		startedAt: '2026-05-14T12:00:00.000Z',
		status: 'paused',
		progress: {
			totalDocuments: 4,
			completedDocuments: 1,
			currentDocument: 'docs/one.md',
			totalTasks: 8,
			completedTasks: 2,
			...overrides.progress,
		},
		tokenUsage: {
			inputTokens: 100,
			outputTokens: 50,
			estimatedCost: 0.25,
			...overrides.tokenUsage,
		},
		timeSpent: 12_000,
		sessionId: 'session-1',
		agentType: 'claude-code',
		...overrides,
	};
}

async function flushAsyncWork(times = 3) {
	for (let i = 0; i < times; i += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

describe('useContribution', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro = {
			symphony: {
				getActive: vi.fn().mockResolvedValue({
					contributions: [createContribution()],
				}),
				updateStatus: vi.fn().mockResolvedValue({ success: true }),
				cancel: vi.fn().mockResolvedValue({ cancelled: true }),
				complete: vi.fn().mockResolvedValue({
					prUrl: 'https://github.com/owner/repo/pull/7',
				}),
			},
		} as any;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns an empty state and no-op action results without a contribution id', async () => {
		const { result } = renderHook(() => useContribution(null));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.contribution).toBeNull();
		expect(result.current.currentDocumentIndex).toBe(0);
		expect(result.current.totalDocuments).toBe(0);
		expect(result.current.currentDocument).toBeNull();

		let cancelResult: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
		let finalizeResult: Awaited<ReturnType<typeof result.current.finalize>> | undefined;
		await act(async () => {
			await result.current.updateProgress({ completedDocuments: 1 });
			await result.current.updateTokenUsage({ inputTokens: 1 });
			await result.current.setStatus('running');
			await result.current.pause();
			await result.current.resume();
			cancelResult = await result.current.cancel(false);
			finalizeResult = await result.current.finalize();
		});

		expect(window.maestro.symphony.getActive).not.toHaveBeenCalled();
		expect(window.maestro.symphony.updateStatus).not.toHaveBeenCalled();
		expect(window.maestro.symphony.cancel).not.toHaveBeenCalled();
		expect(window.maestro.symphony.complete).not.toHaveBeenCalled();
		expect(cancelResult).toEqual({ success: false });
		expect(finalizeResult).toEqual({
			success: false,
			error: 'No active contribution',
		});
	});

	it('loads the matching active contribution and derives progress values', async () => {
		const contribution = createContribution();
		vi.mocked(window.maestro.symphony.getActive).mockResolvedValueOnce({
			contributions: [createContribution({ id: 'other' }), contribution],
		});

		const { result } = renderHook(() => useContribution('contribution-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(window.maestro.symphony.getActive).toHaveBeenCalledTimes(1);
		expect(result.current.error).toBeNull();
		expect(result.current.contribution).toEqual(contribution);
		expect(result.current.currentDocumentIndex).toBe(1);
		expect(result.current.totalDocuments).toBe(4);
		expect(result.current.currentDocument).toBe('docs/one.md');
	});

	it('reports missing and failed contribution loads', async () => {
		vi.mocked(window.maestro.symphony.getActive).mockResolvedValueOnce({} as any);

		const missing = renderHook(() => useContribution('missing-id'));
		await waitFor(() => expect(missing.result.current.isLoading).toBe(false));

		expect(missing.result.current.contribution).toBeNull();
		expect(missing.result.current.error).toBe('Contribution not found');
		missing.unmount();

		vi.mocked(window.maestro.symphony.getActive).mockRejectedValueOnce(
			new Error('state unavailable')
		);

		const errored = renderHook(() => useContribution('contribution-1'));
		await waitFor(() => expect(errored.result.current.isLoading).toBe(false));

		expect(errored.result.current.error).toBe('state unavailable');
		errored.unmount();

		vi.mocked(window.maestro.symphony.getActive).mockRejectedValueOnce('bad ipc');

		const unknownError = renderHook(() => useContribution('contribution-1'));
		await waitFor(() => expect(unknownError.result.current.isLoading).toBe(false));

		expect(unknownError.result.current.error).toBe('Failed to fetch contribution');
	});

	it('does not update state when an in-flight load resolves after unmount', async () => {
		let resolveLoad: ((value: { contributions: ActiveContribution[] }) => void) | undefined;
		vi.mocked(window.maestro.symphony.getActive).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLoad = resolve;
			})
		);

		const { result, unmount } = renderHook(() => useContribution('contribution-1'));
		expect(result.current.isLoading).toBe(true);

		unmount();
		await act(async () => {
			resolveLoad?.({ contributions: [createContribution()] });
		});

		expect(window.maestro.symphony.getActive).toHaveBeenCalledTimes(1);

		let rejectLoad: ((reason?: unknown) => void) | undefined;
		vi.mocked(window.maestro.symphony.getActive).mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectLoad = reject;
			})
		);

		const rejected = renderHook(() => useContribution('contribution-1'));
		expect(rejected.result.current.isLoading).toBe(true);

		rejected.unmount();
		await act(async () => {
			rejectLoad?.(new Error('late failure'));
		});

		expect(window.maestro.symphony.getActive).toHaveBeenCalledTimes(2);
	});

	it('polls running contributions, tracks elapsed time, and clears timers on unmount', async () => {
		const startedAt = '2026-05-14T12:00:00.000Z';
		const running = createContribution({ status: 'running', startedAt });
		vi.mocked(window.maestro.symphony.getActive).mockResolvedValue({
			contributions: [running],
		});
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(new Date(startedAt).getTime() + 5_000);
		const callbacks = new Map<number, () => void>();
		let nextHandle = 100;
		const intervalHandles: number[] = [];
		const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((callback, delay) => {
			const handle = nextHandle++;
			callbacks.set(delay as number, callback as () => void);
			intervalHandles.push(handle);
			return handle as any;
		});
		const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

		const { result, unmount } = renderHook(() => useContribution('contribution-1'));

		await flushAsyncWork();

		expect(result.current.contribution?.status).toBe('running');
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

		expect(result.current.elapsedTime).toBe(5_000);

		dateNow.mockReturnValue(new Date(startedAt).getTime() + 6_000);
		await act(async () => {
			callbacks.get(1000)?.();
		});
		expect(result.current.elapsedTime).toBe(6_000);

		await act(async () => {
			callbacks.get(2000)?.();
			await Promise.resolve();
		});

		expect(window.maestro.symphony.getActive).toHaveBeenCalledTimes(2);
		unmount();
		for (const handle of intervalHandles) {
			expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
		}
	});

	it('does not poll terminal contributions', async () => {
		vi.mocked(window.maestro.symphony.getActive).mockResolvedValueOnce({
			contributions: [createContribution({ status: 'ready_for_review' })],
		});
		const setIntervalSpy = vi.spyOn(global, 'setInterval');

		const { result } = renderHook(() => useContribution('contribution-1'));

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.contribution?.status).toBe('ready_for_review');
		expect(
			setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1000 || delay === 2000)
		).toEqual([]);
	});

	it('updates progress with loaded and pre-load defaults before refreshing contribution data', async () => {
		const { result } = renderHook(() => useContribution('contribution-1'));

		await act(async () => {
			await result.current.updateProgress({});
		});

		expect(window.maestro.symphony.updateStatus).toHaveBeenNthCalledWith(1, {
			contributionId: 'contribution-1',
			progress: {
				totalDocuments: 0,
				completedDocuments: 0,
				totalTasks: 0,
				completedTasks: 0,
				currentDocument: undefined,
			},
		});

		await waitFor(() => expect(result.current.contribution).not.toBeNull());

		await act(async () => {
			await result.current.updateProgress({
				completedDocuments: 3,
				currentDocument: 'docs/two.md',
			});
		});

		expect(window.maestro.symphony.updateStatus).toHaveBeenNthCalledWith(2, {
			contributionId: 'contribution-1',
			progress: {
				totalDocuments: 4,
				completedDocuments: 3,
				totalTasks: 8,
				completedTasks: 2,
				currentDocument: 'docs/two.md',
			},
		});
		expect(window.maestro.symphony.getActive).toHaveBeenCalledTimes(3);
	});

	it('updates token usage and statuses before refreshing contribution data', async () => {
		const { result } = renderHook(() => useContribution('contribution-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.updateTokenUsage({
				inputTokens: 200,
				outputTokens: 90,
				estimatedCost: 0.5,
			});
			await result.current.setStatus('completed');
			await result.current.pause();
			await result.current.resume();
		});

		expect(window.maestro.symphony.updateStatus).toHaveBeenNthCalledWith(1, {
			contributionId: 'contribution-1',
			tokenUsage: {
				inputTokens: 200,
				outputTokens: 90,
				estimatedCost: 0.5,
			},
		});
		expect(window.maestro.symphony.updateStatus).toHaveBeenNthCalledWith(2, {
			contributionId: 'contribution-1',
			status: 'completed',
		});
		expect(window.maestro.symphony.updateStatus).toHaveBeenNthCalledWith(3, {
			contributionId: 'contribution-1',
			status: 'paused',
		});
		expect(window.maestro.symphony.updateStatus).toHaveBeenNthCalledWith(4, {
			contributionId: 'contribution-1',
			status: 'running',
		});
		expect(window.maestro.symphony.getActive).toHaveBeenCalledTimes(5);
	});

	it('cancels with cleanup defaults and maps missing cancellation flags to failure', async () => {
		vi.mocked(window.maestro.symphony.cancel)
			.mockResolvedValueOnce({ cancelled: true })
			.mockResolvedValueOnce({});
		const { result } = renderHook(() => useContribution('contribution-1'));
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		let firstResult: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
		let secondResult: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
		await act(async () => {
			firstResult = await result.current.cancel();
			secondResult = await result.current.cancel(false);
		});

		expect(window.maestro.symphony.cancel).toHaveBeenNthCalledWith(1, 'contribution-1', true);
		expect(window.maestro.symphony.cancel).toHaveBeenNthCalledWith(2, 'contribution-1', false);
		expect(firstResult).toEqual({ success: true });
		expect(secondResult).toEqual({ success: false });
	});

	it('finalizes with contribution stats and reports PR, explicit, and fallback errors', async () => {
		vi.mocked(window.maestro.symphony.complete)
			.mockResolvedValueOnce({ prUrl: 'https://github.com/owner/repo/pull/7' })
			.mockResolvedValueOnce({ error: 'push failed' })
			.mockResolvedValueOnce({});
		const { result } = renderHook(() => useContribution('contribution-1'));
		await waitFor(() => expect(result.current.contribution).not.toBeNull());

		let prResult: Awaited<ReturnType<typeof result.current.finalize>> | undefined;
		let errorResult: Awaited<ReturnType<typeof result.current.finalize>> | undefined;
		let fallbackResult: Awaited<ReturnType<typeof result.current.finalize>> | undefined;
		await act(async () => {
			prResult = await result.current.finalize();
			errorResult = await result.current.finalize();
			fallbackResult = await result.current.finalize();
		});

		expect(window.maestro.symphony.complete).toHaveBeenCalledWith({
			contributionId: 'contribution-1',
			stats: {
				inputTokens: 100,
				outputTokens: 50,
				estimatedCost: 0.25,
				timeSpentMs: 12_000,
				documentsProcessed: 1,
				tasksCompleted: 2,
			},
		});
		expect(prResult).toEqual({
			success: true,
			prUrl: 'https://github.com/owner/repo/pull/7',
		});
		expect(errorResult).toEqual({ success: false, error: 'push failed' });
		expect(fallbackResult).toEqual({ success: false, error: 'Unknown error' });
	});
});
