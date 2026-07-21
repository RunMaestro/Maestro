import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsSearch } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsSearch';
import type { SearchResult } from '../../../../../renderer/components/AgentSessionsBrowser/types';

const mockSearch = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	(window as any).maestro = {
		agentSessions: { search: mockSearch },
	};
	mockSearch.mockResolvedValue([
		{ sessionId: 's1', matchType: 'user', matchPreview: 'hi', matchCount: 1 },
	]);
});

afterEach(() => {
	vi.useRealTimers();
});

const defaults = {
	search: 'hello',
	searchMode: 'user' as const,
	projectPathForSessions: '/project',
	agentId: 'claude-code',
	sshRemoteId: undefined as string | undefined,
};

describe('useAgentSessionsSearch', () => {
	it('title mode returns empty results without calling IPC', async () => {
		const { result } = renderHook(() =>
			useAgentSessionsSearch({ ...defaults, searchMode: 'title' })
		);
		act(() => {
			vi.runAllTimers();
		});
		expect(mockSearch).not.toHaveBeenCalled();
		expect(result.current.searchResults).toEqual([]);
		expect(result.current.isSearching).toBe(false);
	});

	it('empty search returns empty results immediately', async () => {
		const { result } = renderHook(() => useAgentSessionsSearch({ ...defaults, search: '   ' }));
		act(() => {
			vi.runAllTimers();
		});
		expect(mockSearch).not.toHaveBeenCalled();
		expect(result.current.isSearching).toBe(false);
	});

	it('debounces 300ms before calling IPC', async () => {
		renderHook(() => useAgentSessionsSearch(defaults));
		expect(mockSearch).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(299);
		});
		expect(mockSearch).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		await vi.runAllTimersAsync();
		expect(mockSearch).toHaveBeenCalledTimes(1);
	});

	it('cancels previous debounce on rapid input', async () => {
		const { rerender } = renderHook((args) => useAgentSessionsSearch(args), {
			initialProps: defaults,
		});
		act(() => {
			vi.advanceTimersByTime(200);
		});
		act(() => {
			rerender({ ...defaults, search: 'world' });
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});
		await vi.runAllTimersAsync();
		expect(mockSearch).toHaveBeenCalledTimes(1);
		expect(mockSearch).toHaveBeenCalledWith('claude-code', '/project', 'world', 'user', undefined);
	});
	it('keeps newer search results when an older request resolves last', async () => {
		let resolveFirst!: (value: SearchResult[]) => void;
		let resolveSecond!: (value: SearchResult[]) => void;
		const first = new Promise<SearchResult[]>((resolve) => {
			resolveFirst = resolve;
		});
		const second = new Promise<SearchResult[]>((resolve) => {
			resolveSecond = resolve;
		});
		mockSearch.mockImplementationOnce(() => first).mockImplementationOnce(() => second);

		const { result, rerender } = renderHook((args) => useAgentSessionsSearch(args), {
			initialProps: defaults,
		});
		await act(async () => {
			vi.advanceTimersByTime(300);
		});
		rerender({ ...defaults, search: 'newer' });
		await act(async () => {
			vi.advanceTimersByTime(300);
		});

		await act(async () => {
			resolveSecond([
				{ sessionId: 'new', matchType: 'user', matchPreview: 'newer', matchCount: 1 },
			]);
			await Promise.resolve();
		});
		await act(async () => {
			resolveFirst([{ sessionId: 'old', matchType: 'user', matchPreview: 'older', matchCount: 1 }]);
			await Promise.resolve();
		});

		expect(result.current.searchResults).toEqual([
			{ sessionId: 'new', matchType: 'user', matchPreview: 'newer', matchCount: 1 },
		]);
		expect(result.current.isSearching).toBe(false);
	});

	it('IPC call includes all required parameters', async () => {
		renderHook(() => useAgentSessionsSearch({ ...defaults, sshRemoteId: 'ssh-1' }));
		act(() => {
			vi.runAllTimers();
		});
		await vi.runAllTimersAsync();
		expect(mockSearch).toHaveBeenCalledWith('claude-code', '/project', 'hello', 'user', 'ssh-1');
	});

	it('passes undefined sshRemoteId when not set', async () => {
		renderHook(() => useAgentSessionsSearch(defaults));
		act(() => {
			vi.runAllTimers();
		});
		await vi.runAllTimersAsync();
		expect(mockSearch).toHaveBeenCalledWith('claude-code', '/project', 'hello', 'user', undefined);
	});

	it('sets isSearching true during debounce + IPC', async () => {
		const { result } = renderHook(() => useAgentSessionsSearch(defaults));
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(result.current.isSearching).toBe(true);
	});

	it('sets isSearching false on success', async () => {
		const { result } = renderHook(() => useAgentSessionsSearch(defaults));
		await act(async () => {
			vi.runAllTimers();
			await vi.runAllTimersAsync();
		});
		expect(result.current.isSearching).toBe(false);
	});

	it('sets isSearching false on error', async () => {
		mockSearch.mockRejectedValue(new Error('fail'));
		const { result } = renderHook(() => useAgentSessionsSearch(defaults));
		await act(async () => {
			vi.runAllTimers();
			await vi.runAllTimersAsync();
		});
		expect(result.current.isSearching).toBe(false);
	});

	it('clears results on error', async () => {
		mockSearch.mockRejectedValue(new Error('fail'));
		const { result } = renderHook(() => useAgentSessionsSearch(defaults));
		await act(async () => {
			vi.runAllTimers();
			await vi.runAllTimersAsync();
		});
		expect(result.current.searchResults).toEqual([]);
	});

	it('skips IPC when projectPathForSessions is undefined', async () => {
		renderHook(() => useAgentSessionsSearch({ ...defaults, projectPathForSessions: undefined }));
		act(() => {
			vi.runAllTimers();
		});
		await vi.runAllTimersAsync();
		expect(mockSearch).not.toHaveBeenCalled();
	});

	it('cleans up pending timeout on unmount', () => {
		const clearSpy = vi.spyOn(global, 'clearTimeout');
		const { unmount } = renderHook(() => useAgentSessionsSearch(defaults));
		unmount();
		expect(clearSpy).toHaveBeenCalled();
	});
});
