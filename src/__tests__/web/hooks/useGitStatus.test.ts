import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	useGitStatus,
	type GitDiffResult,
	type GitStatusResult,
} from '../../../web/hooks/useGitStatus';

const status: GitStatusResult = {
	branch: 'main',
	files: [{ path: 'src/App.tsx', status: 'modified', staged: false }],
	ahead: 1,
	behind: 0,
};

const diff: GitDiffResult = {
	diff: 'diff --git a/src/App.tsx b/src/App.tsx',
	files: ['src/App.tsx'],
};

describe('useGitStatus', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('auto-loads status once per connected session id', async () => {
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'get_git_status') return { status };
			return {};
		});
		const { result, rerender } = renderHook(
			({ sessionId }) => useGitStatus(sendRequest as any, true, sessionId),
			{ initialProps: { sessionId: 'session-1' } }
		);

		await waitFor(() => expect(result.current.status).toEqual(status));
		expect(sendRequest).toHaveBeenCalledWith('get_git_status', { sessionId: 'session-1' });

		rerender({ sessionId: 'session-1' });
		expect(sendRequest).toHaveBeenCalledTimes(1);

		rerender({ sessionId: 'session-2' });
		await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2));
		expect(sendRequest).toHaveBeenLastCalledWith('get_git_status', { sessionId: 'session-2' });
	});

	it('loads status, diff, and combined refresh when connected', async () => {
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'get_git_status') return { status };
			if (type === 'get_git_diff') return { diff };
			return {};
		});
		const { result } = renderHook(() => useGitStatus(sendRequest as any, true));

		await act(async () => {
			await result.current.loadStatus('session-1');
			await result.current.loadDiff('session-1', 'src/App.tsx');
			await result.current.refresh('session-1');
		});

		expect(result.current.status).toEqual(status);
		expect(result.current.diff).toEqual(diff);
		expect(result.current.isLoading).toBe(false);
		expect(sendRequest).toHaveBeenCalledWith('get_git_diff', {
			sessionId: 'session-1',
			filePath: 'src/App.tsx',
		});
		expect(sendRequest).toHaveBeenCalledWith('get_git_diff', { sessionId: 'session-1' });
	});

	it('no-ops while disconnected and preserves state on request failures', async () => {
		const sendRequest = vi.fn();
		const { result, rerender } = renderHook(
			({ connected }) => useGitStatus(sendRequest as any, connected),
			{ initialProps: { connected: false } }
		);

		await act(async () => {
			await result.current.loadStatus('session-1');
			await result.current.loadDiff('session-1');
			await result.current.refresh('session-1');
		});
		expect(sendRequest).not.toHaveBeenCalled();

		sendRequest.mockResolvedValueOnce({ status });
		rerender({ connected: true });
		await act(async () => {
			await result.current.loadStatus('session-1');
		});
		expect(result.current.status).toEqual(status);

		sendRequest.mockRejectedValue(new Error('offline'));
		await act(async () => {
			await result.current.loadStatus('session-1');
			await result.current.loadDiff('session-1');
			await result.current.refresh('session-1');
		});

		expect(result.current.status).toEqual(status);
		expect(result.current.diff).toBeNull();
		expect(result.current.isLoading).toBe(false);
	});
});
