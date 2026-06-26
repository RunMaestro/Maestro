import { act, renderHook } from '@testing-library/react';
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
});
