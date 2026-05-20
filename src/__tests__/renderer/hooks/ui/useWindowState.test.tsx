import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowState } from '../../../../renderer/hooks/ui/useWindowState';
import { useUIStore } from '../../../../renderer/stores/uiStore';

const initialWindowState = {
	id: 'window-1',
	x: 0,
	y: 0,
	width: 1200,
	height: 800,
	isMaximized: false,
	isFullScreen: false,
	sessionIds: ['session-1'],
	activeSessionId: 'session-1',
	leftPanelCollapsed: true,
	rightPanelCollapsed: false,
};

describe('useWindowState', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useUIStore.setState({
			leftSidebarOpen: true,
			rightPanelOpen: true,
		});

		(window as any).maestro = {
			...(window as any).maestro,
			windows: {
				getState: vi.fn().mockResolvedValue(initialWindowState),
				updateState: vi.fn().mockResolvedValue(initialWindowState),
			},
		};
	});

	it('hydrates panel collapse state for the current window', async () => {
		renderHook(() => useWindowState({ windowId: 'window-1' }));

		await waitFor(() => expect(useUIStore.getState().leftSidebarOpen).toBe(false));

		expect(useUIStore.getState().rightPanelOpen).toBe(true);
		expect(window.maestro.windows.getState).toHaveBeenCalledTimes(1);
		expect(window.maestro.windows.updateState).not.toHaveBeenCalled();
	});

	it('persists panel collapse changes after hydration', async () => {
		renderHook(() => useWindowState({ windowId: 'window-1' }));
		await waitFor(() => expect(useUIStore.getState().leftSidebarOpen).toBe(false));

		act(() => {
			useUIStore.getState().setRightPanelOpen(false);
		});

		await waitFor(() =>
			expect(window.maestro.windows.updateState).toHaveBeenCalledWith({
				rightPanelCollapsed: true,
			})
		);
	});

	it('does not hydrate from a stale window state response', async () => {
		vi.mocked(window.maestro.windows.getState).mockResolvedValue({
			...initialWindowState,
			id: 'window-2',
		});

		renderHook(() => useWindowState({ windowId: 'window-1' }));

		await waitFor(() => expect(window.maestro.windows.getState).toHaveBeenCalledTimes(1));

		expect(useUIStore.getState().leftSidebarOpen).toBe(true);
		expect(window.maestro.windows.updateState).not.toHaveBeenCalled();
	});
});
