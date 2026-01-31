/**
 * Tests for Windows Preload API.
 *
 * Tests that the preload bindings correctly expose all IPC methods
 * for multi-window operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ipcRenderer - must be hoisted, so use vi.hoisted
const mockIpcRenderer = vi.hoisted(() => ({
	invoke: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
	ipcRenderer: mockIpcRenderer,
}));

import { createWindowsApi } from '../../../main/preload/windows';
import type {
	WindowsApi,
	SessionsChangedEvent,
	SessionMovedEvent,
} from '../../../main/preload/windows';

describe('Windows Preload API', () => {
	let windowsApi: WindowsApi;

	beforeEach(() => {
		vi.clearAllMocks();
		windowsApi = createWindowsApi();
	});

	describe('createWindowsApi', () => {
		it('should return an object with all required methods', () => {
			expect(windowsApi).toBeDefined();
			expect(typeof windowsApi.create).toBe('function');
			expect(typeof windowsApi.close).toBe('function');
			expect(typeof windowsApi.list).toBe('function');
			expect(typeof windowsApi.getForSession).toBe('function');
			expect(typeof windowsApi.moveSession).toBe('function');
			expect(typeof windowsApi.focusWindow).toBe('function');
			expect(typeof windowsApi.getState).toBe('function');
			expect(typeof windowsApi.getWindowId).toBe('function');
			expect(typeof windowsApi.setSessionsForWindow).toBe('function');
			expect(typeof windowsApi.setActiveSession).toBe('function');
			expect(typeof windowsApi.onSessionsChanged).toBe('function');
			expect(typeof windowsApi.onSessionMoved).toBe('function');
			expect(typeof windowsApi.getWindowBounds).toBe('function');
		});
	});

	describe('create', () => {
		it('should invoke windows:create with no arguments', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({ windowId: 'win-123' });

			const result = await windowsApi.create();

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:create', undefined);
			expect(result).toEqual({ windowId: 'win-123' });
		});

		it('should invoke windows:create with request options', async () => {
			const request = {
				sessionIds: ['session-1', 'session-2'],
				activeSessionId: 'session-1',
				bounds: { x: 100, y: 200, width: 800, height: 600 },
			};
			mockIpcRenderer.invoke.mockResolvedValueOnce({ windowId: 'win-456' });

			const result = await windowsApi.create(request);

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:create', request);
			expect(result).toEqual({ windowId: 'win-456' });
		});
	});

	describe('close', () => {
		it('should invoke windows:close with windowId', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({ success: true });

			const result = await windowsApi.close('win-123');

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:close', 'win-123');
			expect(result).toEqual({ success: true });
		});

		it('should handle error response', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({
				success: false,
				error: 'Cannot close the primary window',
			});

			const result = await windowsApi.close('primary-window');

			expect(result).toEqual({
				success: false,
				error: 'Cannot close the primary window',
			});
		});
	});

	describe('list', () => {
		it('should invoke windows:list and return window infos', async () => {
			const windowInfos = [
				{ id: 'win-1', isMain: true, sessionIds: ['s1'], activeSessionId: 's1' },
				{ id: 'win-2', isMain: false, sessionIds: ['s2', 's3'], activeSessionId: 's2' },
			];
			mockIpcRenderer.invoke.mockResolvedValueOnce(windowInfos);

			const result = await windowsApi.list();

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:list');
			expect(result).toEqual(windowInfos);
		});
	});

	describe('getForSession', () => {
		it('should invoke windows:getForSession with sessionId', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce('win-123');

			const result = await windowsApi.getForSession('session-abc');

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:getForSession', 'session-abc');
			expect(result).toBe('win-123');
		});

		it('should return null if session not found', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce(null);

			const result = await windowsApi.getForSession('nonexistent');

			expect(result).toBeNull();
		});
	});

	describe('moveSession', () => {
		it('should invoke windows:moveSession with request', async () => {
			const request = {
				sessionId: 'session-1',
				fromWindowId: 'win-1',
				toWindowId: 'win-2',
			};
			mockIpcRenderer.invoke.mockResolvedValueOnce({ success: true });

			const result = await windowsApi.moveSession(request);

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:moveSession', request);
			expect(result).toEqual({ success: true });
		});
	});

	describe('focusWindow', () => {
		it('should invoke windows:focusWindow with windowId', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({ success: true });

			const result = await windowsApi.focusWindow('win-123');

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:focusWindow', 'win-123');
			expect(result).toEqual({ success: true });
		});
	});

	describe('getState', () => {
		it('should invoke windows:getState', async () => {
			const windowState = {
				id: 'win-1',
				x: 100,
				y: 200,
				width: 1200,
				height: 800,
				isMaximized: false,
				isFullScreen: false,
				sessionIds: ['s1', 's2'],
				activeSessionId: 's1',
				leftPanelCollapsed: false,
				rightPanelCollapsed: false,
			};
			mockIpcRenderer.invoke.mockResolvedValueOnce(windowState);

			const result = await windowsApi.getState();

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:getState');
			expect(result).toEqual(windowState);
		});

		it('should return null if window state not found', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce(null);

			const result = await windowsApi.getState();

			expect(result).toBeNull();
		});
	});

	describe('getWindowId', () => {
		it('should invoke windows:getWindowId', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce('win-123');

			const result = await windowsApi.getWindowId();

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:getWindowId');
			expect(result).toBe('win-123');
		});
	});

	describe('setSessionsForWindow', () => {
		it('should invoke windows:setSessionsForWindow with args', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({ success: true });

			const result = await windowsApi.setSessionsForWindow('win-1', ['s1', 's2'], 's1');

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
				'windows:setSessionsForWindow',
				'win-1',
				['s1', 's2'],
				's1'
			);
			expect(result).toEqual({ success: true });
		});

		it('should work without activeSessionId', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({ success: true });

			await windowsApi.setSessionsForWindow('win-1', ['s1', 's2']);

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
				'windows:setSessionsForWindow',
				'win-1',
				['s1', 's2'],
				undefined
			);
		});
	});

	describe('setActiveSession', () => {
		it('should invoke windows:setActiveSession', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce({ success: true });

			const result = await windowsApi.setActiveSession('win-1', 'session-abc');

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
				'windows:setActiveSession',
				'win-1',
				'session-abc'
			);
			expect(result).toEqual({ success: true });
		});
	});

	describe('onSessionsChanged', () => {
		it('should register listener for windows:sessionsChanged', () => {
			const callback = vi.fn();

			windowsApi.onSessionsChanged(callback);

			expect(mockIpcRenderer.on).toHaveBeenCalledWith(
				'windows:sessionsChanged',
				expect.any(Function)
			);
		});

		it('should return cleanup function that removes listener', () => {
			const callback = vi.fn();

			const cleanup = windowsApi.onSessionsChanged(callback);
			cleanup();

			expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
				'windows:sessionsChanged',
				expect.any(Function)
			);
		});

		it('should invoke callback with event data when event fires', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, data: SessionsChangedEvent) => void = () => {};

			mockIpcRenderer.on.mockImplementation((channel: string, handler: Function) => {
				if (channel === 'windows:sessionsChanged') {
					registeredHandler = handler as (event: unknown, data: SessionsChangedEvent) => void;
				}
			});

			windowsApi.onSessionsChanged(callback);

			// Simulate event
			const eventData: SessionsChangedEvent = {
				windowId: 'win-123',
				sessionIds: ['s1', 's2'],
				activeSessionId: 's1',
			};
			registeredHandler({}, eventData);

			expect(callback).toHaveBeenCalledWith(eventData);
		});
	});

	describe('onSessionMoved', () => {
		it('should register listener for windows:sessionMoved', () => {
			const callback = vi.fn();

			windowsApi.onSessionMoved(callback);

			expect(mockIpcRenderer.on).toHaveBeenCalledWith('windows:sessionMoved', expect.any(Function));
		});

		it('should return cleanup function that removes listener', () => {
			const callback = vi.fn();

			const cleanup = windowsApi.onSessionMoved(callback);
			cleanup();

			expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
				'windows:sessionMoved',
				expect.any(Function)
			);
		});

		it('should invoke callback with event data when event fires', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, data: SessionMovedEvent) => void = () => {};

			mockIpcRenderer.on.mockImplementation((channel: string, handler: Function) => {
				if (channel === 'windows:sessionMoved') {
					registeredHandler = handler as (event: unknown, data: SessionMovedEvent) => void;
				}
			});

			windowsApi.onSessionMoved(callback);

			// Simulate event
			const eventData: SessionMovedEvent = {
				sessionId: 'session-1',
				fromWindowId: 'win-123',
				toWindowId: 'win-456',
			};
			registeredHandler({}, eventData);

			expect(callback).toHaveBeenCalledWith(eventData);
		});
	});

	describe('getWindowBounds', () => {
		it('should invoke windows:getWindowBounds', async () => {
			const bounds = { x: 100, y: 200, width: 1200, height: 800 };
			mockIpcRenderer.invoke.mockResolvedValueOnce(bounds);

			const result = await windowsApi.getWindowBounds();

			expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windows:getWindowBounds');
			expect(result).toEqual(bounds);
		});

		it('should return null if bounds not available', async () => {
			mockIpcRenderer.invoke.mockResolvedValueOnce(null);

			const result = await windowsApi.getWindowBounds();

			expect(result).toBeNull();
		});
	});
});
