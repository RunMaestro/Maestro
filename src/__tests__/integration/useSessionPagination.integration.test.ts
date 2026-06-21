/**
 * Tests for useSessionPagination hook
 *
 * This hook manages paginated session loading for AgentSessionsBrowser.
 * Key functionality tested:
 * - Loads sessions using projectPath (not cwd) for consistent session storage access
 * - Handles starred sessions loading from origins
 * - Supports cursor-based pagination
 * - Auto-loads remaining sessions in background
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionPagination } from '../../renderer/hooks';
import { logger } from '../../renderer/utils/logger';

// Mock the window.maestro API
const mockListPaginated = vi.fn();
const mockGetSessionOrigins = vi.fn();
const mockGetProjectStats = vi.fn();
const mockGetOrigins = vi.fn();

vi.mock('../../renderer/types', () => ({}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
	},
}));

beforeEach(() => {
	vi.clearAllMocks();

	// Setup window.maestro mock
	(window as unknown as { maestro: unknown }).maestro = {
		agentSessions: {
			listPaginated: mockListPaginated,
			getOrigins: mockGetOrigins,
		},
		claude: {
			getSessionOrigins: mockGetSessionOrigins,
			getProjectStats: mockGetProjectStats,
		},
	};

	// Default mock implementations
	mockListPaginated.mockResolvedValue({
		sessions: [],
		hasMore: false,
		totalCount: 0,
		nextCursor: null,
	});
	mockGetSessionOrigins.mockResolvedValue({});
	mockGetProjectStats.mockResolvedValue({});
	mockGetOrigins.mockResolvedValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('useSessionPagination', () => {
	describe('projectPath parameter', () => {
		it('uses projectPath for loading sessions', async () => {
			mockListPaginated.mockResolvedValue({
				sessions: [{ sessionId: 'test-session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			});

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockListPaginated).toHaveBeenCalledWith(
				'claude-code',
				'/path/to/project',
				{ limit: 100 },
				undefined // sshRemoteId
			);
		});

		it('uses projectPath for loading starred sessions from origins', async () => {
			mockGetSessionOrigins.mockResolvedValue({
				'session-1': { origin: 'user', starred: true },
				'session-2': { origin: 'user', starred: false },
			});

			const onStarredSessionsLoaded = vi.fn();

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
					onStarredSessionsLoaded,
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockGetSessionOrigins).toHaveBeenCalledWith('/path/to/project');
			expect(onStarredSessionsLoaded).toHaveBeenCalledWith(new Set(['session-1']));
		});

		it('uses projectPath for loading project stats', async () => {
			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockGetProjectStats).toHaveBeenCalledWith('/path/to/project');
		});

		it('does not load sessions when projectPath is undefined', async () => {
			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: undefined,
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockListPaginated).not.toHaveBeenCalled();
			expect(mockGetSessionOrigins).not.toHaveBeenCalled();
		});

		it('logs initial load failures and exits loading state', async () => {
			mockListPaginated.mockRejectedValueOnce(new Error('initial load failed'));

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(logger.error).toHaveBeenCalledWith(
				'Failed to load sessions:',
				undefined,
				expect.any(Error)
			);
			expect(result.current.sessions).toEqual([]);
		});
	});

	describe('pagination', () => {
		it('loads more sessions with the same projectPath', async () => {
			mockListPaginated
				.mockResolvedValueOnce({
					sessions: [{ sessionId: 'session-1' }],
					hasMore: true,
					totalCount: 2,
					nextCursor: 'cursor-1',
				})
				.mockResolvedValueOnce({
					sessions: [{ sessionId: 'session-2' }],
					hasMore: false,
					totalCount: 2,
					nextCursor: null,
				});

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			// Wait for initial load
			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			// The hook auto-loads remaining sessions in background
			await waitFor(() => {
				expect(result.current.hasMoreSessions).toBe(false);
			});

			// Both calls should use the same projectPath
			expect(mockListPaginated).toHaveBeenNthCalledWith(
				1,
				'claude-code',
				'/path/to/project',
				{ limit: 100 },
				undefined // sshRemoteId
			);
			expect(mockListPaginated).toHaveBeenNthCalledWith(
				2,
				'claude-code',
				'/path/to/project',
				{ cursor: 'cursor-1', limit: 100 },
				undefined // sshRemoteId
			);
		});

		it('ignores load more when pagination has no cursor', async () => {
			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.loadMoreSessions();
			});

			expect(mockListPaginated).toHaveBeenCalledTimes(1);
		});

		it('logs load-more failures and clears loading state', async () => {
			mockListPaginated
				.mockResolvedValueOnce({
					sessions: [],
					hasMore: true,
					totalCount: 2,
					nextCursor: 'cursor-1',
				})
				.mockRejectedValueOnce(new Error('load more failed'))
				.mockResolvedValue({
					sessions: [],
					hasMore: false,
					totalCount: 2,
					nextCursor: null,
				});

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.loadMoreSessions();
			});

			expect(logger.error).toHaveBeenCalledWith(
				'Failed to load more sessions:',
				undefined,
				expect.any(Error)
			);
			expect(result.current.isLoadingMoreSessions).toBe(false);
		});

		it('loads more sessions when scrolling past the pagination threshold', async () => {
			mockListPaginated
				.mockResolvedValueOnce({
					sessions: [],
					hasMore: true,
					totalCount: 2,
					nextCursor: 'cursor-1',
				})
				.mockResolvedValue({
					sessions: [{ sessionId: 'session-2' }],
					hasMore: false,
					totalCount: 2,
					nextCursor: null,
				});

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			act(() => {
				result.current.handleSessionsScroll();
			});
			expect(mockListPaginated).toHaveBeenCalledTimes(1);

			const container = document.createElement('div');
			Object.defineProperties(container, {
				scrollTop: { configurable: true, writable: true, value: 20 },
				clientHeight: { configurable: true, value: 20 },
				scrollHeight: { configurable: true, value: 100 },
			});
			(
				result.current.sessionsContainerRef as unknown as { current: HTMLDivElement | null }
			).current = container;

			act(() => {
				result.current.handleSessionsScroll();
			});
			expect(mockListPaginated).toHaveBeenCalledTimes(1);

			container.scrollTop = 60;
			act(() => {
				result.current.handleSessionsScroll();
			});

			await waitFor(() => {
				expect(mockListPaginated).toHaveBeenCalledWith(
					'claude-code',
					'/path/to/project',
					{ cursor: 'cursor-1', limit: 100 },
					undefined
				);
			});
		});

		it('does not keep auto-loading when a page adds no new sessions', async () => {
			let resolveDuplicatePage!: (value: {
				sessions: Array<{ sessionId: string }>;
				hasMore: boolean;
				totalCount: number;
				nextCursor: string;
			}) => void;
			const duplicatePage = new Promise<{
				sessions: Array<{ sessionId: string }>;
				hasMore: boolean;
				totalCount: number;
				nextCursor: string;
			}>((resolve) => {
				resolveDuplicatePage = resolve;
			});

			mockListPaginated
				.mockResolvedValueOnce({
					sessions: [{ sessionId: 'session-1' }],
					hasMore: true,
					totalCount: 2,
					nextCursor: 'cursor-1',
				})
				.mockReturnValueOnce(duplicatePage);

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 80));
			});

			await waitFor(() => {
				expect(mockListPaginated).toHaveBeenCalledTimes(2);
			});
			await waitFor(() => {
				expect(result.current.isLoadingMoreSessions).toBe(true);
			});

			await act(async () => {
				resolveDuplicatePage({
					sessions: [{ sessionId: 'session-1' }],
					hasMore: true,
					totalCount: 2,
					nextCursor: 'cursor-2',
				});
				await duplicatePage;
			});

			await waitFor(() => {
				expect(result.current.isLoadingMoreSessions).toBe(false);
			});
			expect(result.current.sessions).toHaveLength(1);
			expect(result.current.hasMoreSessions).toBe(true);

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 80));
			});

			expect(mockListPaginated).toHaveBeenCalledTimes(2);
		});
	});

	describe('sshRemoteId parameter', () => {
		it('passes sshRemoteId to listPaginated when provided', async () => {
			mockListPaginated.mockResolvedValue({
				sessions: [{ sessionId: 'test-session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			});

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'claude-code',
					sshRemoteId: 'ssh-remote-1',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockListPaginated).toHaveBeenCalledWith(
				'claude-code',
				'/path/to/project',
				{ limit: 100 },
				'ssh-remote-1' // sshRemoteId should be passed
			);
		});

		it('reloads sessions when sshRemoteId changes', async () => {
			mockListPaginated.mockResolvedValue({
				sessions: [{ sessionId: 'test-session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			});

			const { result, rerender } = renderHook(
				({ sshRemoteId }) =>
					useSessionPagination({
						projectPath: '/path/to/project',
						agentId: 'claude-code',
						sshRemoteId,
					}),
				{ initialProps: { sshRemoteId: undefined as string | undefined } }
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			// First call without sshRemoteId
			expect(mockListPaginated).toHaveBeenCalledWith(
				'claude-code',
				'/path/to/project',
				{ limit: 100 },
				undefined
			);

			// Change sshRemoteId
			rerender({ sshRemoteId: 'ssh-remote-1' });

			await waitFor(() => {
				expect(mockListPaginated).toHaveBeenCalledWith(
					'claude-code',
					'/path/to/project',
					{ limit: 100 },
					'ssh-remote-1'
				);
			});
		});
	});

	describe('non-claude agents', () => {
		it('does not call getSessionOrigins for non-claude agents', async () => {
			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'opencode',
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockGetSessionOrigins).not.toHaveBeenCalled();
			expect(mockGetProjectStats).not.toHaveBeenCalled();
			expect(mockListPaginated).toHaveBeenCalledWith(
				'opencode',
				'/path/to/project',
				{ limit: 100 },
				undefined // sshRemoteId
			);
		});

		it('merges generic origins and reports starred non-Claude sessions', async () => {
			mockGetOrigins.mockResolvedValue({
				'codex-session': {
					origin: 'auto',
					sessionName: 'Codex Imported Name',
					starred: true,
				},
				'unstarred-session': {
					origin: 'user',
					sessionName: 'Unstarred Imported Name',
					starred: false,
				},
			});
			mockListPaginated.mockResolvedValue({
				sessions: [
					{
						sessionId: 'codex-session',
						sessionName: 'Original Name',
						starred: false,
					},
					{
						sessionId: 'unstarred-session',
						sessionName: 'Original Unstarred Name',
						starred: false,
					},
				],
				hasMore: false,
				totalCount: 2,
				nextCursor: null,
			});
			const onStarredSessionsLoaded = vi.fn();

			const { result } = renderHook(() =>
				useSessionPagination({
					projectPath: '/path/to/project',
					agentId: 'codex',
					onStarredSessionsLoaded,
				})
			);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(mockGetOrigins).toHaveBeenCalledWith('codex', '/path/to/project');
			expect(onStarredSessionsLoaded).toHaveBeenCalledWith(new Set(['codex-session']));
			expect(result.current.sessions[0]).toEqual(
				expect.objectContaining({
					sessionId: 'codex-session',
					sessionName: 'Codex Imported Name',
					starred: true,
					origin: 'auto',
				})
			);
			expect(result.current.sessions[1]).toEqual(
				expect.objectContaining({
					sessionId: 'unstarred-session',
					sessionName: 'Unstarred Imported Name',
					starred: false,
					origin: 'user',
				})
			);
		});
	});

	it('merges Claude string origins and can update loaded sessions', async () => {
		mockGetSessionOrigins.mockResolvedValue({
			'session-1': 'auto',
			'session-with-malformed-origin': 42,
			'session-2': {
				origin: 'user',
				sessionName: 'Named Claude Session',
				starred: true,
			},
		});
		mockListPaginated.mockResolvedValue({
			sessions: [
				{ sessionId: 'session-1', sessionName: 'First' },
				{ sessionId: 'session-with-malformed-origin', sessionName: 'Malformed Origin' },
				{ sessionId: 'session-2', sessionName: 'Second', starred: false },
			],
			hasMore: false,
			totalCount: 2,
			nextCursor: null,
		});

		const { result } = renderHook(() =>
			useSessionPagination({
				projectPath: '/path/to/project',
				agentId: 'claude-code',
			})
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.sessions).toEqual([
			expect.objectContaining({
				sessionId: 'session-1',
				sessionName: 'First',
				origin: 'auto',
			}),
			expect.objectContaining({
				sessionId: 'session-with-malformed-origin',
				sessionName: 'Malformed Origin',
				origin: undefined,
			}),
			expect.objectContaining({
				sessionId: 'session-2',
				sessionName: 'Named Claude Session',
				starred: true,
				origin: 'user',
			}),
		]);

		act(() => {
			result.current.updateSession('session-2', { sessionName: 'Renamed Session' });
		});

		expect(result.current.sessions).toEqual([
			expect.objectContaining({ sessionName: 'First' }),
			expect.objectContaining({ sessionName: 'Malformed Origin' }),
			expect.objectContaining({ sessionName: 'Renamed Session' }),
		]);
	});
});
