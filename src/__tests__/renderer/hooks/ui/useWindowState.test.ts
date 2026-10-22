/**
 * useWindowState: hydrate panel state from the window's persisted state and
 * write later toggles back. A web-desktop client has no window to persist to
 * (the bridge refuses `windows:setPanelState`), so it must never call it: the
 * refusal surfaced as a "Submission rejected" notice on every panel toggle.
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

	it('hydrates but never persists from a web-desktop client', async () => {
		mockIsWebDesktop.mockReturnValue(true);
		getState.mockResolvedValue({ leftPanelCollapsed: false, rightPanelCollapsed: true });
		await renderHydrated();
		expect(useUIStore.getState().rightPanelOpen).toBe(false);

		act(() => useUIStore.getState().setRightPanelOpen(true));
		act(() => useUIStore.getState().setLeftSidebarOpen(false));
		act(() => vi.advanceTimersByTime(1000));
		expect(setPanelState).not.toHaveBeenCalled();
	});
});
