import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebBroadcasting } from '../../../renderer/hooks';
import type { RightPanelHandle } from '../../../renderer/components/RightPanel';
import type { RefObject } from 'react';

// Type for the window.maestro.history mock
type HistoryMock = {
	onExternalChange: Mock<(handler: () => Promise<void>) => () => void>;
	reload: Mock<() => Promise<boolean>>;
};

describe('useWebBroadcasting', () => {
	let originalMaestro: typeof window.maestro;
	let historyMock: HistoryMock;
	let externalChangeHandler: (() => Promise<void>) | null = null;
	let unsubscribeFn: Mock;

	const createRightPanelRef = (): RefObject<RightPanelHandle | null> => ({
		current: {
			refreshHistoryPanel: vi.fn(),
			focusAutoRun: vi.fn(),
			toggleAutoRunExpanded: vi.fn(),
		},
	});

	beforeEach(() => {
		externalChangeHandler = null;
		unsubscribeFn = vi.fn();

		historyMock = {
			onExternalChange: vi.fn((handler: () => Promise<void>) => {
				externalChangeHandler = handler;
				return unsubscribeFn;
			}),
			reload: vi.fn().mockResolvedValue(true),
		};

		originalMaestro = window.maestro;
		window.maestro = {
			...originalMaestro,
			history: {
				...originalMaestro?.history,
				...historyMock,
			},
		} as unknown as typeof window.maestro;
	});

	afterEach(() => {
		window.maestro = originalMaestro;
		vi.clearAllMocks();
	});

	it('should subscribe to external history changes on mount', () => {
		const rightPanelRef = createRightPanelRef();

		renderHook(() => useWebBroadcasting({ rightPanelRef }));

		expect(historyMock.onExternalChange).toHaveBeenCalledOnce();
		expect(historyMock.onExternalChange).toHaveBeenCalledWith(expect.any(Function));
	});

	it('should unsubscribe on unmount', () => {
		const rightPanelRef = createRightPanelRef();

		const { unmount } = renderHook(() => useWebBroadcasting({ rightPanelRef }));

		expect(unsubscribeFn).not.toHaveBeenCalled();

		unmount();

		expect(unsubscribeFn).toHaveBeenCalledOnce();
	});

	it('should reload history and refresh panel when external change is detected', async () => {
		const rightPanelRef = createRightPanelRef();

		renderHook(() => useWebBroadcasting({ rightPanelRef }));

		expect(externalChangeHandler).toBeDefined();

		// Trigger external change
		await act(async () => {
			await externalChangeHandler?.();
		});

		expect(historyMock.reload).toHaveBeenCalledOnce();
		await waitFor(() => {
			expect(rightPanelRef.current?.refreshHistoryPanel).toHaveBeenCalledOnce();
		});
	});

	it('should handle null rightPanelRef gracefully', async () => {
		const rightPanelRef: RefObject<RightPanelHandle | null> = { current: null };

		renderHook(() => useWebBroadcasting({ rightPanelRef }));

		// Trigger external change when ref is null - should not throw
		await act(async () => {
			await externalChangeHandler?.();
		});

		expect(historyMock.reload).toHaveBeenCalledOnce();
		// No error should be thrown
	});

	it('should return empty object', () => {
		const rightPanelRef = createRightPanelRef();

		const { result } = renderHook(() => useWebBroadcasting({ rightPanelRef }));

		expect(result.current).toEqual({});
	});

	it('should resubscribe when rightPanelRef changes', () => {
		const rightPanelRef1 = createRightPanelRef();
		const rightPanelRef2 = createRightPanelRef();

		const { rerender } = renderHook(({ rightPanelRef }) => useWebBroadcasting({ rightPanelRef }), {
			initialProps: { rightPanelRef: rightPanelRef1 },
		});

		expect(historyMock.onExternalChange).toHaveBeenCalledTimes(1);
		expect(unsubscribeFn).not.toHaveBeenCalled();

		// Change the ref
		rerender({ rightPanelRef: rightPanelRef2 });

		// Should unsubscribe old and subscribe new
		expect(unsubscribeFn).toHaveBeenCalledOnce();
		expect(historyMock.onExternalChange).toHaveBeenCalledTimes(2);
	});
});
