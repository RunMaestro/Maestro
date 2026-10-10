import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveOverlay } from '../../../../renderer/hooks/remote/useLiveOverlay';

describe('useLiveOverlay', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('cancels the copy flash timeout when unmounted', () => {
		const { result, unmount } = renderHook(() => useLiveOverlay(false));

		act(() => {
			result.current.setCopyFlash('Local URL copied!');
		});
		expect(result.current.copyFlash).toBe('Local URL copied!');
		expect(vi.getTimerCount()).toBe(1);

		unmount();

		expect(vi.getTimerCount()).toBe(0);
	});
});
