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
});
