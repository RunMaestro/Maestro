import React, { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowProvider, useWindowContext } from '../../../renderer/contexts/WindowContext';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import type {
	WindowDropZoneHighlightEvent,
	WindowSessionMovedEvent,
	WindowSessionsMovedToPrimaryEvent,
} from '../../../shared/types/window';

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
	let sessionMovedHandler: ((event: WindowSessionMovedEvent) => void) | undefined;
	let sessionsMovedToPrimaryHandler:
		| ((event: WindowSessionsMovedToPrimaryEvent) => void)
		| undefined;
	let dropZoneHighlightHandler: ((event: WindowDropZoneHighlightEvent) => void) | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		sessionMovedHandler = undefined;
		sessionsMovedToPrimaryHandler = undefined;
		dropZoneHighlightHandler = undefined;
		useNotificationStore.setState({
			toasts: [],
			config: {
				defaultDuration: 20,
				audioFeedbackEnabled: false,
				audioFeedbackCommand: '',
				osNotificationsEnabled: false,
			},
		});

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
				onSessionMoved: vi.fn((handler) => {
					sessionMovedHandler = handler;
					return vi.fn();
				}),
				onSessionsMovedToPrimary: vi.fn((handler) => {
					sessionsMovedToPrimaryHandler = handler;
					return vi.fn();
				}),
				onDropZoneHighlightChanged: vi.fn((handler) => {
					dropZoneHighlightHandler = handler;
					return vi.fn();
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

	it('updates local tabs when a session is moved out of this window', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));
		await waitFor(() => expect(window.maestro.windows.onSessionMoved).toHaveBeenCalledTimes(1));

		act(() => {
			sessionMovedHandler?.({
				sessionId: 'session-1',
				fromWindowId: 'window-1',
				toWindowId: 'window-2',
				windows: [
					{
						id: 'window-1',
						isMain: true,
						sessionIds: ['session-2'],
						activeSessionId: 'session-1',
					},
					{
						id: 'window-2',
						isMain: false,
						sessionIds: ['session-3', 'session-1'],
						activeSessionId: 'session-3',
					},
				],
			});
		});

		expect(result.current.sessionIds).toEqual(['session-2']);
		expect(result.current.activeSessionId).toBe('session-2');
	});

	it('updates local tabs when a session is moved into this window', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));
		await waitFor(() => expect(window.maestro.windows.onSessionMoved).toHaveBeenCalledTimes(1));

		act(() => {
			sessionMovedHandler?.({
				sessionId: 'session-3',
				fromWindowId: 'window-2',
				toWindowId: 'window-1',
				windows: [
					{
						id: 'window-1',
						isMain: true,
						sessionIds: ['session-1', 'session-2', 'session-3'],
						activeSessionId: 'session-1',
					},
					{
						id: 'window-2',
						isMain: false,
						sessionIds: [],
						activeSessionId: null,
					},
				],
			});
		});

		expect(result.current.sessionIds).toEqual(['session-1', 'session-2', 'session-3']);
		expect(result.current.activeSessionId).toBe('session-1');
	});

	it('updates primary tabs and shows a toast when a secondary window closes', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));
		await waitFor(() =>
			expect(window.maestro.windows.onSessionsMovedToPrimary).toHaveBeenCalledTimes(1)
		);

		act(() => {
			sessionsMovedToPrimaryHandler?.({
				sessionIds: ['session-3', 'session-4'],
				fromWindowId: 'window-2',
				toWindowId: 'window-1',
				windows: [
					{
						id: 'window-1',
						isMain: true,
						sessionIds: ['session-1', 'session-2', 'session-3', 'session-4'],
						activeSessionId: 'session-1',
					},
				],
			});
		});

		expect(result.current.sessionIds).toEqual(['session-1', 'session-2', 'session-3', 'session-4']);
		expect(useNotificationStore.getState().toasts[0]).toMatchObject({
			type: 'info',
			title: '2 sessions moved to main window',
			message: '',
		});
	});

	it('updates drop zone highlight state from window events', async () => {
		const { result } = renderHook(() => useWindowContext(), { wrapper });
		await waitFor(() => expect(result.current.windowId).toBe('window-1'));

		act(() => {
			dropZoneHighlightHandler?.({ highlighted: true });
		});

		expect(result.current.isDropZoneHighlighted).toBe(true);

		act(() => {
			dropZoneHighlightHandler?.({ highlighted: false });
		});

		expect(result.current.isDropZoneHighlighted).toBe(false);
	});
});
