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
import { useSessionPagination } from '../../../renderer/hooks';

// Mock the window.maestro API
const mockListPaginated = vi.fn();
const mockGetSessionOrigins = vi.fn();
const mockGetProjectStats = vi.fn();
const mockGetOrigins = vi.fn();

vi.mock('../../../renderer/types', () => ({}));

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
	});
});
