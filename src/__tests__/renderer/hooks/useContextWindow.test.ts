import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useContextWindow } from '../../../renderer/hooks/mainPanel/useContextWindow';
import type { Session } from '../../../renderer/types';

const mockGetConfig = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		agents: {
			getConfig: mockGetConfig,
		},
	};
});

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test',
		cwd: '/test',
		fullPath: '/test',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: false,
		bookmarked: false,
		...overrides,
	} as Session;
}

describe('useContextWindow', () => {
	it('returns zeros when no session', () => {
		const { result } = renderHook(() => useContextWindow(null, null));

		expect(result.current.activeTabContextWindow).toBe(0);
		expect(result.current.activeTabContextTokens).toBe(0);
		expect(result.current.activeTabContextUsage).toBe(0);
	});

	it('loads context window from agent config', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
		const session = makeSession();

		const { result } = renderHook(() => useContextWindow(session, null));

		await waitFor(() => {
			expect(result.current.activeTabContextWindow).toBe(200000);
		});
	});

	it('uses session customContextWindow override', async () => {
		const session = makeSession({ customContextWindow: 100000 });

		const { result } = renderHook(() => useContextWindow(session, null));

		await waitFor(() => {
			expect(result.current.activeTabContextWindow).toBe(100000);
		});
		// Should not call getConfig when override is set
		expect(mockGetConfig).not.toHaveBeenCalled();
	});

	it('falls back to reported context window when no config', async () => {
		mockGetConfig.mockResolvedValue({});
		const session = makeSession();
		const tab = {
			usageStats: {
				contextWindow: 150000,
				inputTokens: 1000,
				outputTokens: 500,
			},
		};

		const { result } = renderHook(() => useContextWindow(session, tab));

		await waitFor(() => {
			expect(result.current.activeTabContextWindow).toBe(150000);
		});
	});

	it('calculates context tokens and usage percentage', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
		const session = makeSession();
		const tab = {
			usageStats: {
				inputTokens: 50000,
				outputTokens: 10000,
				cacheCreationInputTokens: 5000,
				cacheReadInputTokens: 2000,
			},
		};

		const { result } = renderHook(() => useContextWindow(session, tab));

		await waitFor(() => {
			expect(result.current.activeTabContextWindow).toBe(200000);
		});
		expect(result.current.activeTabContextTokens).toBeGreaterThan(0);
		expect(result.current.activeTabContextUsage).toBeGreaterThanOrEqual(0);
		expect(result.current.activeTabContextUsage).toBeLessThanOrEqual(100);
	});

	it('returns zero tokens when no usage stats', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
		const session = makeSession();

		const { result } = renderHook(() => useContextWindow(session, null));

		await waitFor(() => {
			expect(result.current.activeTabContextWindow).toBe(200000);
		});
		expect(result.current.activeTabContextTokens).toBe(0);
		expect(result.current.activeTabContextUsage).toBe(0);
	});

	it('handles agent config fetch failure', async () => {
		mockGetConfig.mockRejectedValue(new Error('Failed'));
		const session = makeSession();

		const { result } = renderHook(() => useContextWindow(session, null));

		await waitFor(() => {
			expect(mockGetConfig).toHaveBeenCalled();
		});
		expect(result.current.activeTabContextWindow).toBe(0);
	});

	it('cleans up on unmount (isActive flag)', async () => {
		vi.useFakeTimers();
		try {
			mockGetConfig.mockImplementation(
				() => new Promise((resolve) => setTimeout(() => resolve({ contextWindow: 200000 }), 100))
			);
			const session = makeSession();

			const { unmount } = renderHook(() => useContextWindow(session, null));
			unmount();

			// Advance past the async delay — should not throw or set state after unmount
			await vi.advanceTimersByTimeAsync(150);
		} finally {
			vi.useRealTimers();
		}
	});
});
