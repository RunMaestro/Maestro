import React, { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowProvider, useWindowContext } from '../../../renderer/contexts/WindowContext';

const initialWindowState = {
	id: 'window-1',
	x: 0,
	y: 0,
	width: 1200,
	height: 800,
	isMaximized: false,
	isFullScreen: false,
	sessionIds: ['session-1', 'session-2'],
	activeSessionId: 'session-1',
	leftPanelCollapsed: false,
	rightPanelCollapsed: false,
};

function wrapper({ children }: { children: ReactNode }) {
	return <WindowProvider>{children}</WindowProvider>;
}

describe('WindowContext', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		(window as any).maestro = {
			...(window as any).maestro,
			windows: {
				getState: vi.fn().mockResolvedValue(initialWindowState),
				list: vi.fn().mockResolvedValue([
					{
						id: 'window-1',
						isMain: true,
						sessionIds: ['session-1', 'session-2'],
						activeSessionId: 'session-1',
					},
					{
						id: 'window-2',
						isMain: false,
						sessionIds: ['session-3'],
						activeSessionId: 'session-3',
					},
				]),
				getForSession: vi.fn().mockResolvedValue(null),
				focusWindow: vi.fn().mockResolvedValue(true),
				create: vi.fn().mockResolvedValue({
					id: 'window-3',
					isMain: false,
					sessionIds: ['session-2'],
					activeSessionId: null,
				}),
			},
		};
	});

	it('initializes from the current window state', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });

		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		expect(result.current.isMainWindow).toBe(true);
		expect(result.current.sessionIds).toEqual(['session-1', 'session-2']);
		expect(result.current.activeSessionId).toBe('session-1');
		expect(window.maestro.windows.getState).toHaveBeenCalledTimes(1);
	});

	it('activates a session that is already open in this window', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		await act(async () => {
			await result.current.openSession('session-2');
		});

		expect(result.current.activeSessionId).toBe('session-2');
		expect(window.maestro.windows.getForSession).not.toHaveBeenCalled();
	});

	it('focuses another window when opening a session owned elsewhere', async () => {
		vi.mocked(window.maestro.windows.getForSession).mockResolvedValue('window-2');
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		await act(async () => {
			await result.current.openSession('session-3');
		});

		expect(window.maestro.windows.focusWindow).toHaveBeenCalledWith('window-2');
		expect(result.current.sessionIds).toEqual(['session-1', 'session-2']);
		expect(result.current.activeSessionId).toBe('session-1');
	});

	it('adds an unassigned session to this window and activates it', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		await act(async () => {
			await result.current.openSession('session-4');
		});

		expect(result.current.sessionIds).toEqual(['session-1', 'session-2', 'session-4']);
		expect(result.current.activeSessionId).toBe('session-4');
	});

	it('closes tabs locally and chooses the next active session', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		act(() => {
			result.current.closeTab('session-1');
		});

		expect(result.current.sessionIds).toEqual(['session-2']);
		expect(result.current.activeSessionId).toBe('session-2');
	});

	it('moves a session into a new window and removes the local tab', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		let newWindowId: string | undefined;
		await act(async () => {
			const newWindow = await result.current.moveSessionToNewWindow('session-2');
			newWindowId = newWindow.id;
		});

		expect(window.maestro.windows.create).toHaveBeenCalledWith(['session-2']);
		expect(newWindowId).toBe('window-3');
		expect(result.current.sessionIds).toEqual(['session-1']);
		expect(result.current.activeSessionId).toBe('session-1');
	});
});
