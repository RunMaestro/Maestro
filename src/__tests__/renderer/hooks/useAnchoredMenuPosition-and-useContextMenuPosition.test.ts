// Source: src/__tests__/renderer/hooks/useAnchoredMenuPosition.test.ts
// Source: src/__tests__/renderer/hooks/useContextMenuPosition.test.ts
// Source: src/__tests__/renderer/hooks/useContextWindow.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useAnchoredMenuPosition } from '../../../renderer/hooks/ui/useAnchoredMenuPosition';
import { vi } from 'vitest';
import { useContextMenuPosition } from '../../../renderer/hooks/ui/useContextMenuPosition';
import { beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useContextWindow } from '../../../renderer/hooks/mainPanel/useContextWindow';
import type { Session } from '../../../renderer/types';
describeSourceSuite('useAnchoredMenuPosition', () => {
	describe('useAnchoredMenuPosition', () => {
		const originalInnerWidth = window.innerWidth;
		const originalInnerHeight = window.innerHeight;
		const created: HTMLElement[] = [];

		afterEach(() => {
			Object.defineProperty(window, 'innerWidth', {
				value: originalInnerWidth,
				configurable: true,
			});
			Object.defineProperty(window, 'innerHeight', {
				value: originalInnerHeight,
				configurable: true,
			});
			created.splice(0).forEach((el) => el.remove());
		});

		function setupViewport(width: number, height: number) {
			Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
			Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
		}

		/** A real element whose measured box is fixed, so placement math is testable. */
		function elementWithRect(rect: { left: number; top: number; width: number; height: number }) {
			const el = document.createElement('div');
			el.getBoundingClientRect = () =>
				({
					left: rect.left,
					top: rect.top,
					right: rect.left + rect.width,
					bottom: rect.top + rect.height,
					width: rect.width,
					height: rect.height,
					x: rect.left,
					y: rect.top,
					toJSON: () => ({}),
				}) as DOMRect;
			document.body.appendChild(el);
			created.push(el);
			return el;
		}

		function placeBeside(
			anchorEl: HTMLElement,
			menuEl: HTMLElement,
			options: Parameters<typeof useAnchoredMenuPosition>[2]
		) {
			return renderHook(() => {
				const menuRef = useRef<HTMLElement>(menuEl);
				const anchorRef = useRef<HTMLElement>(anchorEl);
				return useAnchoredMenuPosition(menuRef, anchorRef, options);
			});
		}

		it('places a right-side flyout past the anchor edge, aligned to its top', () => {
			setupViewport(1000, 800);
			const anchor = elementWithRect({ left: 100, top: 300, width: 100, height: 28 });
			const menu = elementWithRect({ left: 0, top: 0, width: 160, height: 200 });

			const { result } = placeBeside(anchor, menu, { placement: 'right', gap: 4, flip: true });

			expect(result.current.left).toBe(204);
			expect(result.current.top).toBe(300);
			expect(result.current.ready).toBe(true);
		});

		it('flips a right-side flyout to the left when it would overflow the viewport', () => {
			setupViewport(400, 800);
			const anchor = elementWithRect({ left: 220, top: 100, width: 80, height: 28 });
			const menu = elementWithRect({ left: 0, top: 0, width: 160, height: 200 });

			const { result } = placeBeside(anchor, menu, { placement: 'right', gap: 4, flip: true });

			// 220 - 4 - 160: the flyout's right edge sits a gap short of the anchor.
			expect(result.current.left).toBe(56);
		});

		it('keeps the preferred side when neither side has room', () => {
			setupViewport(300, 800);
			const anchor = elementWithRect({ left: 100, top: 100, width: 100, height: 28 });
			const menu = elementWithRect({ left: 0, top: 0, width: 260, height: 100 });

			const { result } = placeBeside(anchor, menu, { placement: 'right', gap: 4, flip: true });

			// Preferred side wins and the viewport clamp pulls it back on screen
			// (300 - 260 - 8 padding) rather than flipping into another overflow.
			expect(result.current.left).toBe(32);
		});

		it('leaves below-placement behaviour alone', () => {
			setupViewport(1000, 800);
			const anchor = elementWithRect({ left: 100, top: 300, width: 100, height: 28 });
			const menu = elementWithRect({ left: 0, top: 0, width: 160, height: 200 });

			const { result } = placeBeside(anchor, menu, { placement: 'below', gap: 6 });

			expect(result.current.left).toBe(100);
			expect(result.current.top).toBe(334);
		});
	});
});
describeSourceSuite('useContextMenuPosition', () => {
	describe('useContextMenuPosition', () => {
		const originalInnerWidth = window.innerWidth;
		const originalInnerHeight = window.innerHeight;
		const originalGetBCR = Element.prototype.getBoundingClientRect;

		afterEach(() => {
			Object.defineProperty(window, 'innerWidth', {
				value: originalInnerWidth,
				configurable: true,
			});
			Object.defineProperty(window, 'innerHeight', {
				value: originalInnerHeight,
				configurable: true,
			});
			Element.prototype.getBoundingClientRect = originalGetBCR;
			vi.restoreAllMocks();
		});

		function setupViewport(width: number, height: number) {
			Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
			Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
		}

		function mockMenuSize(width: number, height: number) {
			Element.prototype.getBoundingClientRect = function () {
				return {
					width,
					height,
					top: 0,
					left: 0,
					right: width,
					bottom: height,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			};
		}

		it('returns click position when menu fits within viewport', () => {
			setupViewport(1024, 768);
			mockMenuSize(160, 120);

			const el = document.createElement('div');
			document.body.appendChild(el);

			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(el);
				return useContextMenuPosition(ref, 200, 300);
			});

			expect(result.current.left).toBe(200);
			expect(result.current.top).toBe(300);
			expect(result.current.ready).toBe(true);

			document.body.removeChild(el);
		});

		it('clamps position when menu would overflow right edge', () => {
			setupViewport(800, 600);
			mockMenuSize(180, 120);

			const el = document.createElement('div');
			document.body.appendChild(el);

			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(el);
				return useContextMenuPosition(ref, 750, 100);
			});

			// 800 - 180 - 8 (padding) = 612
			expect(result.current.left).toBe(612);
			expect(result.current.top).toBe(100);
			expect(result.current.ready).toBe(true);

			document.body.removeChild(el);
		});

		it('clamps position when menu would overflow bottom edge', () => {
			setupViewport(800, 600);
			mockMenuSize(160, 200);

			const el = document.createElement('div');
			document.body.appendChild(el);

			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(el);
				return useContextMenuPosition(ref, 100, 500);
			});

			// 600 - 200 - 8 (padding) = 392
			expect(result.current.left).toBe(100);
			expect(result.current.top).toBe(392);
			expect(result.current.ready).toBe(true);

			document.body.removeChild(el);
		});

		it('clamps position when menu would overflow both edges', () => {
			setupViewport(800, 600);
			mockMenuSize(180, 200);

			const el = document.createElement('div');
			document.body.appendChild(el);

			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(el);
				return useContextMenuPosition(ref, 750, 500);
			});

			expect(result.current.left).toBe(612); // 800 - 180 - 8
			expect(result.current.top).toBe(392); // 600 - 200 - 8
			expect(result.current.ready).toBe(true);

			document.body.removeChild(el);
		});

		it('enforces minimum padding from top-left', () => {
			setupViewport(800, 600);
			mockMenuSize(100, 100);

			const el = document.createElement('div');
			document.body.appendChild(el);

			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(el);
				return useContextMenuPosition(ref, 2, 3);
			});

			// Math.max(8, 2) = 8, Math.max(8, 3) = 8
			expect(result.current.left).toBe(8);
			expect(result.current.top).toBe(8);

			document.body.removeChild(el);
		});

		it('respects custom padding parameter', () => {
			setupViewport(800, 600);
			mockMenuSize(180, 120);

			const el = document.createElement('div');
			document.body.appendChild(el);

			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(el);
				return useContextMenuPosition(ref, 750, 100, 16);
			});

			// 800 - 180 - 16 = 604
			expect(result.current.left).toBe(604);
			expect(result.current.top).toBe(100);

			document.body.removeChild(el);
		});

		it('remeasures when menu content changes', () => {
			setupViewport(800, 600);
			let menuHeight = 100;
			Element.prototype.getBoundingClientRect = function () {
				return {
					width: 160,
					height: menuHeight,
					top: 0,
					left: 0,
					right: 160,
					bottom: menuHeight,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			};

			const el = document.createElement('div');
			document.body.appendChild(el);
			const { result, rerender } = renderHook(
				({ submenuOpen }: { submenuOpen: boolean }) => {
					const ref = useRef<HTMLDivElement>(el);
					return useContextMenuPosition(ref, 100, 500, 8, submenuOpen);
				},
				{ initialProps: { submenuOpen: false } }
			);

			expect(result.current.top).toBe(492);

			menuHeight = 200;
			rerender({ submenuOpen: true });

			expect(result.current.top).toBe(392);
			document.body.removeChild(el);
		});

		/**
		 * A menu taller than the viewport is the case that used to be silently
		 * broken: clamping POSITION alone pins it to the top edge and lets it run
		 * off the bottom, and the containers are `overflow-hidden`, so those items
		 * cannot be reached at all - a context menu does not scroll the page.
		 */
		describe('maxHeight budget', () => {
			it('caps a menu taller than the viewport to what fits', () => {
				setupViewport(1200, 600);
				mockMenuSize(200, 900);

				const el = document.createElement('div');
				document.body.appendChild(el);
				const { result } = renderHook(() => {
					const ref = useRef<HTMLDivElement>(el);
					return useContextMenuPosition(ref, 100, 400);
				});

				// Pinned to the top padding, because maxTop went negative.
				expect(result.current.top).toBe(8);
				// Everything from there to the bottom padding is usable, and nothing
				// beyond it is - which is what the caller turns into a scroller.
				expect(result.current.maxHeight).toBe(600 - 8 - 8);
				document.body.removeChild(el);
			});

			it('measures the budget from where the menu LANDS, not from the click', () => {
				// A short menu near the bottom is pushed UP by the position clamp, so
				// it has more room than the click point suggests. Budgeting from `y`
				// would under-report and add a scrollbar to a menu that fits.
				setupViewport(1200, 600);
				mockMenuSize(200, 100);

				const el = document.createElement('div');
				document.body.appendChild(el);
				const { result } = renderHook(() => {
					const ref = useRef<HTMLDivElement>(el);
					return useContextMenuPosition(ref, 100, 580);
				});

				expect(result.current.top).toBe(492);
				expect(result.current.maxHeight).toBe(600 - 492 - 8);
				document.body.removeChild(el);
			});

			it('never reports a negative budget', () => {
				setupViewport(1200, 10);
				mockMenuSize(200, 900);

				const el = document.createElement('div');
				document.body.appendChild(el);
				const { result } = renderHook(() => {
					const ref = useRef<HTMLDivElement>(el);
					return useContextMenuPosition(ref, 100, 5);
				});

				expect(result.current.maxHeight).toBeGreaterThanOrEqual(0);
				document.body.removeChild(el);
			});
		});

		it('returns ready=false when ref has no element', () => {
			const { result } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(null);
				return useContextMenuPosition(ref, 100, 200);
			});

			expect(result.current.ready).toBe(false);
			expect(result.current.left).toBe(100);
			expect(result.current.top).toBe(200);
		});
	});
});
describeSourceSuite('useContextWindow', () => {
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
			// so a provider-resolved window outranks it. Note the ABSENCE of
			// `contextWindowSource` is what marks it materialized - there is no
			// `'materialized'` value to assign, by design (review of PR #1362).
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

		// Finding AD1. P1 ranks a provider report above every stored value, which is
		// right for the materialized defaults that dominate the store but silently
		// discards the intent of someone who deliberately lowered their window to
		// force earlier compaction. Provenance is what tells the two apart.
		it('keeps a user-edited window above a resolved runtime window', async () => {
			const session = makeSession({
				toolType: 'omp',
				customContextWindow: 120000,
				contextWindowSource: 'user-edited',
			});
			const tab = {
				usageStats: {
					contextWindow: 1_000_000,
					contextWindowResolved: true,
					inputTokens: 1000,
					outputTokens: 500,
				},
			};

			const { result } = renderHook(() => useContextWindow(session, tab));

			await waitFor(() => expect(result.current.activeTabContextWindow).toBe(120000));
		});

		it('keeps a [1m] custom-model marker above a user-edited window', async () => {
			mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
			// Both are deliberate choices, but the model marker is the more specific
			// one: picking `[1m]` selects a model variant, and a stale window typed
			// before that switch must not shrink it back.
			const session = makeSession({
				customModel: 'opus[1m]',
				customContextWindow: 120000,
				contextWindowSource: 'user-edited',
			});
			const tab = { usageStats: { contextWindow: 200000, inputTokens: 10, outputTokens: 5 } };

			const { result } = renderHook(() => useContextWindow(session, tab));

			await waitFor(() => expect(result.current.activeTabContextWindow).toBe(1_000_000));
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

		it('reads the occupancy snapshot, not the summed turn spend, on a 1M window (#1782)', async () => {
			mockGetConfig.mockResolvedValue({});
			const session = makeSession();
			// A tool-heavy Claude turn: the top-level fields sum ~7 internal API calls
			// and stay UNDER the 1M window, so the overflow guard never fires.
			const tab = {
				id: 'tab-1',
				usageStats: {
					contextWindow: 1_000_000,
					contextWindowResolved: true,
					inputTokens: 22,
					outputTokens: 4_100,
					cacheReadInputTokens: 437_222,
					cacheCreationInputTokens: 89_297,
					totalCostUsd: 0,
					absoluteUsage: {
						inputTokens: 3,
						outputTokens: 600,
						cacheReadInputTokens: 78_900,
						cacheCreationInputTokens: 4_500,
						reasoningTokens: 0,
					},
				},
			};

			const { result } = renderHook(() => useContextWindow(session, tab as any));

			await waitFor(() => {
				expect(result.current.activeTabContextWindow).toBe(1_000_000);
			});
			expect(result.current.activeTabContextTokens).toBe(83_403);
			expect(result.current.activeTabContextUsage).toBe(8);
		});

		it('still reads the top-level fields for a tab stored without a snapshot', async () => {
			mockGetConfig.mockResolvedValue({});
			const session = makeSession();
			const tab = {
				id: 'tab-1',
				usageStats: {
					contextWindow: 1_000_000,
					contextWindowResolved: true,
					inputTokens: 10,
					outputTokens: 500,
					cacheReadInputTokens: 60_000,
					cacheCreationInputTokens: 5_000,
					totalCostUsd: 0,
				},
			};

			const { result } = renderHook(() => useContextWindow(session, tab as any));

			await waitFor(() => {
				expect(result.current.activeTabContextWindow).toBe(1_000_000);
			});
			expect(result.current.activeTabContextTokens).toBe(65_010);
			expect(result.current.activeTabContextUsage).toBe(7);
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
});
