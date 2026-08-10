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

	it('lets a resolved runtime window beat the configured fallback', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
		const session = makeSession({ toolType: 'omp' });
		const tab = {
			usageStats: {
				contextWindow: 1_000_000,
				contextWindowResolved: true,
				inputTokens: 1000,
				outputTokens: 500,
			},
		};

		const { result } = renderHook(() => useContextWindow(session, tab));

		// Let the agent config (200k fallback) actually resolve, so we prove the
		// resolved window beats a REAL configured value, not merely an unresolved 0.
		await waitFor(() => expect(mockGetConfig).toHaveBeenCalled());
		await waitFor(() => expect(result.current.activeTabContextWindow).toBe(1_000_000));
	});

	it('lets a resolved runtime window beat a stored customContextWindow override', async () => {
		// Finding P1 / D1: the stored value is a materialized creation-time default,
		// so a provider-resolved window outranks it.
		const session = makeSession({ toolType: 'omp', customContextWindow: 200000 });
		const tab = {
			usageStats: {
				contextWindow: 1_000_000,
				contextWindowResolved: true,
				inputTokens: 1000,
				outputTokens: 500,
			},
		};

		const { result } = renderHook(() => useContextWindow(session, tab));

		await waitFor(() => expect(result.current.activeTabContextWindow).toBe(1_000_000));
	});

	it('still returns the stored override when the reported window is not flagged resolved', async () => {
		// Without the authority flag the reported window may be a parser-injected
		// static fallback, so the stored value stays in charge.
		const session = makeSession({ toolType: 'omp', customContextWindow: 200000 });
		const tab = {
			usageStats: {
				contextWindow: 1_000_000,
				inputTokens: 1000,
				outputTokens: 500,
			},
		};

		const { result } = renderHook(() => useContextWindow(session, tab));

		await waitFor(() => expect(result.current.activeTabContextWindow).toBe(200000));
	});

	it('keeps a [1m] custom-model marker above a resolved window', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
		// An explicit [1m] model choice is authoritative and must outrank a
		// runtime-resolved window, matching useAgentUsageListener's precedence.
		const session = makeSession({ customModel: 'opus[1m]' });
		const tab = {
			usageStats: {
				contextWindow: 200000,
				contextWindowResolved: true,
				inputTokens: 1000,
				outputTokens: 500,
			},
		};

		const { result } = renderHook(() => useContextWindow(session, tab));

		// The `[1m]` marker is resolved synchronously and short-circuits the config
		// lookup, so the value is 1M from first render; confirm it never yields to
		// the runtime-resolved window.
		await waitFor(() => expect(result.current.activeTabContextWindow).toBe(1_000_000));
		// The marker path short-circuits before the agent-config lookup.
		expect(mockGetConfig).not.toHaveBeenCalled();
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

	it('holds the last good values when an overflow frame has a zero contextUsage fallback', async () => {
		// Finding Q1 / D3: a zero fallback used to be laundered into a
		// trustworthy `0 tokens / 0%` result, which `lastGoodRef` then cached as
		// last-known-good and re-latched on every later frame. With the `> 0`
		// guard in calculateContextDisplay the overflow frame is untrustworthy,
		// so the cache keeps the real reading from the in-window frame.
		const session = makeSession({ customContextWindow: 200000, contextUsage: 30 });
		const inWindowTab = {
			id: 'tab-1',
			usageStats: {
				inputTokens: 50000,
				outputTokens: 1000,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 10000,
			},
		};

		const { result, rerender } = renderHook(
			({ s, t }: { s: Session; t: any }) => useContextWindow(s, t),
			{ initialProps: { s: session, t: inWindowTab } }
		);

		await waitFor(() => {
			expect(result.current.activeTabContextWindow).toBe(200000);
		});
		// 60,000 of 200,000 = 30%
		expect(result.current.activeTabContextTokens).toBe(60000);
		expect(result.current.activeTabContextUsage).toBe(30);

		// A tool-heavy turn reports accumulated tokens above the window while the
		// session has no preserved percentage to fall back on.
		const overflowSession = makeSession({ customContextWindow: 200000, contextUsage: 0 });
		const overflowTab = {
			id: 'tab-1',
			usageStats: {
				inputTokens: 2_400_000,
				outputTokens: 5000,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			},
		};

		rerender({ s: overflowSession, t: overflowTab });

		expect(result.current.activeTabContextTokens).toBe(60000);
		expect(result.current.activeTabContextUsage).toBe(30);
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

			// Advance past the async delay - should not throw or set state after unmount
			await vi.advanceTimersByTimeAsync(150);
		} finally {
			vi.useRealTimers();
		}
	});
});
