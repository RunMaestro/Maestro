import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode, useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuotaRefresh } from '../../../../renderer/components/UsageDashboard/quota/useQuotaRefresh';
import { useUIStore } from '../../../../renderer/stores/uiStore';

describe('useQuotaRefresh', () => {
	afterEach(() => {
		vi.useRealTimers();
		useUIStore.setState({ usageRefreshIntervals: {} });
	});

	it('settles an in-flight refresh after unmount without a late state update', async () => {
		vi.useFakeTimers();
		const doRefresh = vi.fn().mockResolvedValue(undefined);

		const { result, unmount } = renderHook(() =>
			useQuotaRefresh({
				providerId: 'claude-code',
				refreshing: false,
				autoRefresh: false,
				accountCount: 0,
				snapshotCount: 0,
				doRefresh,
			})
		);

		let refreshPromise!: Promise<void>;
		act(() => {
			refreshPromise = result.current.handleRefresh();
		});
		expect(result.current.isBusy).toBe(true);

		await Promise.resolve();
		unmount();

		await vi.advanceTimersByTimeAsync(900);
		await expect(refreshPromise).resolves.toBeUndefined();
		expect(doRefresh).toHaveBeenCalledTimes(1);
	});

	it('recovers visual busy state after a StrictMode effect remount', async () => {
		vi.useFakeTimers();
		const doRefresh = vi.fn().mockResolvedValue(undefined);
		const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
		let refreshPromise!: Promise<void>;

		const useAutoStartedQuotaRefresh = () => {
			const refresh = useQuotaRefresh({
				providerId: 'claude-code',
				refreshing: false,
				autoRefresh: false,
				accountCount: 0,
				snapshotCount: 0,
				doRefresh,
			});
			const startedRef = useRef(false);

			useEffect(() => {
				if (startedRef.current) return;
				startedRef.current = true;
				refreshPromise = refresh.handleRefresh();
			}, [refresh]);

			return refresh;
		};

		const { result } = renderHook(() => useAutoStartedQuotaRefresh(), { wrapper });
		expect(result.current.isBusy).toBe(true);

		await Promise.resolve();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(900);
			await refreshPromise;
		});

		expect(result.current.isBusy).toBe(false);
		expect(doRefresh).toHaveBeenCalledTimes(1);
	});

	describe('Grok quota refresh', () => {
		const grokOptions = (doRefresh: () => Promise<void>, overrides = {}) => ({
			providerId: 'grok',
			refreshing: false,
			autoRefresh: true,
			accountCount: 0,
			snapshotCount: 0,
			doRefresh,
			...overrides,
		});

		it('never auto-samples a provider with no quota accounts', async () => {
			vi.useFakeTimers();
			const doRefresh = vi.fn().mockResolvedValue(undefined);
			const { result } = renderHook(() => useQuotaRefresh(grokOptions(doRefresh)));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000);
			});
			expect(doRefresh).not.toHaveBeenCalled();
			expect(result.current.isBusy).toBe(false);
		});

		it('reads an unset interval as off, not an inferred cadence, and keeps it per provider', () => {
			const doRefresh = vi.fn().mockResolvedValue(undefined);
			useUIStore.setState({ usageRefreshIntervals: { codex: 300_000 } });
			const grok = renderHook(() => useQuotaRefresh(grokOptions(doRefresh)));
			const claude = renderHook(() =>
				useQuotaRefresh(grokOptions(doRefresh, { providerId: 'claude-code' }))
			);

			expect(grok.result.current.refreshIntervalMs).toBe(0);
			act(() => grok.result.current.setRefreshIntervalMs(60_000));
			expect(useUIStore.getState().usageRefreshIntervals).toEqual({ codex: 300_000, grok: 60_000 });
			expect(grok.result.current.refreshIntervalMs).toBe(60_000);
			expect(claude.result.current.refreshIntervalMs).toBe(0);
		});

		it('keeps a cached snapshot instead of auto-sampling over it', async () => {
			vi.useFakeTimers();
			const doRefresh = vi.fn().mockResolvedValue(undefined);
			renderHook(() =>
				useQuotaRefresh(
					grokOptions(doRefresh, { providerId: 'codex', accountCount: 2, snapshotCount: 2 })
				)
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000);
			});
			expect(doRefresh).not.toHaveBeenCalled();
		});

		it('recovers from an auth or permission refusal and allows a later refresh', async () => {
			vi.useFakeTimers();
			const doRefresh = vi
				.fn()
				.mockRejectedValueOnce(new Error('401 unauthenticated'))
				.mockResolvedValueOnce(undefined);
			const { result } = renderHook(() =>
				useQuotaRefresh(grokOptions(doRefresh, { providerId: 'codex', autoRefresh: false }))
			);

			let first!: Promise<void>;
			act(() => {
				first = result.current.handleRefresh();
			});
			expect(result.current.isBusy).toBe(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(900);
				await first;
			});
			expect(result.current.isBusy).toBe(false);

			await act(async () => {
				const second = result.current.handleRefresh();
				await vi.advanceTimersByTimeAsync(900);
				await second;
			});
			expect(doRefresh).toHaveBeenCalledTimes(2);
			expect(result.current.isBusy).toBe(false);
		});

		it('ignores a manual refresh while the provider store reports one in flight', async () => {
			const doRefresh = vi.fn().mockResolvedValue(undefined);
			const { result } = renderHook(() =>
				useQuotaRefresh(grokOptions(doRefresh, { refreshing: true, autoRefresh: false }))
			);

			await act(async () => {
				await result.current.handleRefresh();
			});
			expect(doRefresh).not.toHaveBeenCalled();
			expect(result.current.isBusy).toBe(true);
		});
	});
});
