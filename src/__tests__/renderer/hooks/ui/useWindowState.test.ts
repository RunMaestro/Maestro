/**
 * Panel state persists per native window. A web-desktop client must retain its
 * own navigation rather than reading or changing the host window's panels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWindowState } from '../../../../renderer/hooks/ui/useWindowState';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));

const mockIsWebDesktop = vi.mocked(isWebDesktop);
const getState = vi.fn();
const setPanelState = vi.fn();

async function renderHydrated() {
	const hook = renderHook(() => useWindowState());
	// Let the async getState() hydration settle.
	await act(async () => {});
	return hook;
}

describe('useWindowState', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockIsWebDesktop.mockReturnValue(false);
		getState
			.mockReset()
			.mockResolvedValue({ leftPanelCollapsed: false, rightPanelCollapsed: false });
		setPanelState.mockReset().mockResolvedValue(undefined);
		Object.assign(window.maestro.windows, { getState, setPanelState });
		useUIStore.getState().setLeftSidebarOpen(true);
		useUIStore.getState().setRightPanelOpen(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('persists a panel toggle in the desktop app (debounced)', async () => {
		await renderHydrated();
		act(() => useUIStore.getState().setRightPanelOpen(false));
		expect(setPanelState).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(400));
		expect(setPanelState).toHaveBeenCalledWith({
			leftPanelCollapsed: false,
			rightPanelCollapsed: true,
		});
	});

	it('keeps client panel navigation independent of the host window', async () => {
		mockIsWebDesktop.mockReturnValue(true);
		useUIStore.getState().setLeftSidebarOpen(false);
		getState.mockResolvedValue({ leftPanelCollapsed: false, rightPanelCollapsed: true });
		await renderHydrated();
		expect(useUIStore.getState()).toMatchObject({
			leftSidebarOpen: false,
			rightPanelOpen: true,
		});

		act(() => useUIStore.getState().setRightPanelOpen(false));
		act(() => useUIStore.getState().setLeftSidebarOpen(true));
		act(() => vi.advanceTimersByTime(1000));
		expect(useUIStore.getState()).toMatchObject({
			leftSidebarOpen: true,
			rightPanelOpen: false,
		});
		expect(getState).not.toHaveBeenCalled();
		expect(setPanelState).not.toHaveBeenCalled();
	});
});
