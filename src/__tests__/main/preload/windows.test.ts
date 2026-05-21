/**
 * Tests for multi-window preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createWindowsApi } from '../../../main/preload/windows';

describe('Windows Preload API', () => {
	let api: ReturnType<typeof createWindowsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createWindowsApi();
	});

	it('should invoke windows:create with defaults', async () => {
		const windowInfo = {
			id: 'window-1',
			isMain: false,
			sessionIds: [],
			activeSessionId: null,
		};
		mockInvoke.mockResolvedValue(windowInfo);

		const result = await api.create();

		expect(mockInvoke).toHaveBeenCalledWith('windows:create', [], {});
		expect(result).toEqual(windowInfo);
	});

	it('should invoke windows:create with session IDs and bounds', async () => {
		const bounds = { x: 20, y: 30, width: 1000, height: 800 };
		mockInvoke.mockResolvedValue({
			id: 'window-2',
			isMain: false,
			sessionIds: ['session-1'],
			activeSessionId: null,
		});

		await api.create(['session-1'], bounds);

		expect(mockInvoke).toHaveBeenCalledWith('windows:create', ['session-1'], bounds);
	});

	it('should invoke windows:close with window ID', async () => {
		mockInvoke.mockResolvedValue({ closed: true });

		const result = await api.close('window-2');

		expect(mockInvoke).toHaveBeenCalledWith('windows:close', 'window-2');
		expect(result).toEqual({ closed: true });
	});

	it('should invoke windows:list', async () => {
		const windows = [
			{ id: 'primary', isMain: true, sessionIds: ['session-1'], activeSessionId: 'session-1' },
		];
		mockInvoke.mockResolvedValue(windows);

		const result = await api.list();

		expect(mockInvoke).toHaveBeenCalledWith('windows:list');
		expect(result).toEqual(windows);
	});

	it('should invoke windows:getForSession with session ID', async () => {
		mockInvoke.mockResolvedValue('window-1');

		const result = await api.getForSession('session-1');

		expect(mockInvoke).toHaveBeenCalledWith('windows:getForSession', 'session-1');
		expect(result).toBe('window-1');
	});

	it('should invoke windows:moveSession with source and target window IDs', async () => {
		mockInvoke.mockResolvedValue(true);

		const result = await api.moveSession('session-1', 'window-1', 'window-2');

		expect(mockInvoke).toHaveBeenCalledWith(
			'windows:moveSession',
			'session-1',
			'window-1',
			'window-2'
		);
		expect(result).toBe(true);
	});

	it('should invoke windows:focusWindow with window ID', async () => {
		mockInvoke.mockResolvedValue(true);

		const result = await api.focusWindow('window-2');

		expect(mockInvoke).toHaveBeenCalledWith('windows:focusWindow', 'window-2');
		expect(result).toBe(true);
	});

	it('should invoke windows:getWindowBounds', async () => {
		const bounds = { x: 10, y: 20, width: 1200, height: 800 };
		mockInvoke.mockResolvedValue(bounds);

		const result = await api.getWindowBounds();

		expect(mockInvoke).toHaveBeenCalledWith('windows:getWindowBounds');
		expect(result).toEqual(bounds);
	});

	it('should invoke windows:findWindowAtPoint with screen coordinates', async () => {
		const windowInfo = {
			id: 'window-2',
			isMain: false,
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
		};
		mockInvoke.mockResolvedValue(windowInfo);

		const result = await api.findWindowAtPoint(640, 320);

		expect(mockInvoke).toHaveBeenCalledWith('windows:findWindowAtPoint', 640, 320);
		expect(result).toEqual(windowInfo);
	});

	it('should invoke windows:highlightDropZone with window ID and state', async () => {
		mockInvoke.mockResolvedValue(true);

		const result = await api.highlightDropZone('window-2', true);

		expect(mockInvoke).toHaveBeenCalledWith('windows:highlightDropZone', 'window-2', true);
		expect(result).toBe(true);
	});

	it('should invoke windows:getState', async () => {
		const state = {
			id: 'window-1',
			x: 0,
			y: 0,
			width: 1200,
			height: 800,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		};
		mockInvoke.mockResolvedValue(state);

		const result = await api.getState();

		expect(mockInvoke).toHaveBeenCalledWith('windows:getState');
		expect(result).toEqual(state);
	});

	it('should invoke windows:updateState', async () => {
		const state = {
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
		mockInvoke.mockResolvedValue(state);

		const result = await api.updateState({ leftPanelCollapsed: true });

		expect(mockInvoke).toHaveBeenCalledWith('windows:updateState', { leftPanelCollapsed: true });
		expect(result).toEqual(state);
	});

	it('should subscribe to windows:sessionMoved events', () => {
		const handler = vi.fn();

		const unsubscribe = api.onSessionMoved(handler);
		const wrappedHandler = mockOn.mock.calls[0][1] as Function;
		wrappedHandler({}, { sessionId: 'session-1' });
		unsubscribe();

		expect(mockOn).toHaveBeenCalledWith('windows:sessionMoved', expect.any(Function));
		expect(handler).toHaveBeenCalledWith({ sessionId: 'session-1' });
		expect(mockRemoveListener).toHaveBeenCalledWith('windows:sessionMoved', wrappedHandler);
	});

	it('should subscribe to windows:sessionsMovedToPrimary events', () => {
		const handler = vi.fn();

		const unsubscribe = api.onSessionsMovedToPrimary(handler);
		const wrappedHandler = mockOn.mock.calls[0][1] as Function;
		wrappedHandler({}, { sessionIds: ['session-1'], toWindowId: 'primary' });
		unsubscribe();

		expect(mockOn).toHaveBeenCalledWith('windows:sessionsMovedToPrimary', expect.any(Function));
		expect(handler).toHaveBeenCalledWith({ sessionIds: ['session-1'], toWindowId: 'primary' });
		expect(mockRemoveListener).toHaveBeenCalledWith(
			'windows:sessionsMovedToPrimary',
			wrappedHandler
		);
	});

	it('should subscribe to windows:dropZoneHighlightChanged events', () => {
		const handler = vi.fn();

		const unsubscribe = api.onDropZoneHighlightChanged(handler);
		const wrappedHandler = mockOn.mock.calls[0][1] as Function;
		wrappedHandler({}, { highlighted: true });
		unsubscribe();

		expect(mockOn).toHaveBeenCalledWith('windows:dropZoneHighlightChanged', expect.any(Function));
		expect(handler).toHaveBeenCalledWith({ highlighted: true });
		expect(mockRemoveListener).toHaveBeenCalledWith(
			'windows:dropZoneHighlightChanged',
			wrappedHandler
		);
	});
});
