/**
 * Tests for src/shared/types/window.ts
 *
 * Tests the window type definitions for multi-window support.
 * Since these are pure type definitions, tests verify type compatibility
 * and that the types can be used correctly.
 */

import { describe, it, expect } from 'vitest';
import type {
	WindowState,
	MultiWindowState,
	WindowInfo,
	CreateWindowRequest,
	CreateWindowResponse,
	MoveSessionRequest,
} from '../../../shared/types/window';
import { DEFAULT_WINDOW_BOUNDS, MIN_WINDOW_BOUNDS } from '../../../shared/types/window';

describe('WindowState', () => {
	it('should allow creating a valid WindowState object', () => {
		const state: WindowState = {
			id: 'window-1',
			x: 100,
			y: 200,
			width: 1200,
			height: 800,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: ['session-1', 'session-2'],
			activeSessionId: 'session-1',
			leftPanelCollapsed: false,
			rightPanelCollapsed: true,
		};

		expect(state.id).toBe('window-1');
		expect(state.x).toBe(100);
		expect(state.y).toBe(200);
		expect(state.width).toBe(1200);
		expect(state.height).toBe(800);
		expect(state.isMaximized).toBe(false);
		expect(state.isFullScreen).toBe(false);
		expect(state.sessionIds).toEqual(['session-1', 'session-2']);
		expect(state.activeSessionId).toBe('session-1');
		expect(state.leftPanelCollapsed).toBe(false);
		expect(state.rightPanelCollapsed).toBe(true);
	});

	it('should allow activeSessionId to be undefined', () => {
		const state: WindowState = {
			id: 'window-1',
			x: 0,
			y: 0,
			width: 800,
			height: 600,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: [],
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		};

		expect(state.activeSessionId).toBeUndefined();
		expect(state.sessionIds).toEqual([]);
	});

	it('should support maximized and full-screen states', () => {
		const maximizedState: WindowState = {
			id: 'window-1',
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
			isMaximized: true,
			isFullScreen: false,
			sessionIds: ['session-1'],
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		};

		const fullScreenState: WindowState = {
			id: 'window-2',
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
			isMaximized: false,
			isFullScreen: true,
			sessionIds: ['session-2'],
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		};

		expect(maximizedState.isMaximized).toBe(true);
		expect(maximizedState.isFullScreen).toBe(false);
		expect(fullScreenState.isMaximized).toBe(false);
		expect(fullScreenState.isFullScreen).toBe(true);
	});
});

describe('MultiWindowState', () => {
	it('should allow creating a valid MultiWindowState object', () => {
		const primaryWindow: WindowState = {
			id: 'primary-window',
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

		const secondaryWindow: WindowState = {
			id: 'secondary-window',
			x: 200,
			y: 100,
			width: 1000,
			height: 700,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: ['session-2', 'session-3'],
			activeSessionId: 'session-2',
			leftPanelCollapsed: true,
			rightPanelCollapsed: false,
		};

		const multiWindowState: MultiWindowState = {
			windows: [primaryWindow, secondaryWindow],
			primaryWindowId: 'primary-window',
		};

		expect(multiWindowState.windows).toHaveLength(2);
		expect(multiWindowState.primaryWindowId).toBe('primary-window');
		expect(multiWindowState.windows[0].id).toBe('primary-window');
		expect(multiWindowState.windows[1].id).toBe('secondary-window');
	});

	it('should support empty windows array', () => {
		const emptyState: MultiWindowState = {
			windows: [],
			primaryWindowId: '',
		};

		expect(emptyState.windows).toHaveLength(0);
	});
});

describe('WindowInfo', () => {
	it('should allow creating a valid WindowInfo object', () => {
		const info: WindowInfo = {
			id: 'window-1',
			isMain: true,
			sessionIds: ['session-1', 'session-2'],
			activeSessionId: 'session-1',
		};

		expect(info.id).toBe('window-1');
		expect(info.isMain).toBe(true);
		expect(info.sessionIds).toEqual(['session-1', 'session-2']);
		expect(info.activeSessionId).toBe('session-1');
	});

	it('should allow activeSessionId to be undefined', () => {
		const info: WindowInfo = {
			id: 'window-1',
			isMain: false,
			sessionIds: [],
		};

		expect(info.activeSessionId).toBeUndefined();
	});

	it('should differentiate between main and secondary windows', () => {
		const mainWindow: WindowInfo = {
			id: 'primary',
			isMain: true,
			sessionIds: ['session-1'],
		};

		const secondaryWindow: WindowInfo = {
			id: 'secondary',
			isMain: false,
			sessionIds: ['session-2'],
		};

		expect(mainWindow.isMain).toBe(true);
		expect(secondaryWindow.isMain).toBe(false);
	});
});

describe('CreateWindowRequest', () => {
	it('should allow creating a request with all options', () => {
		const request: CreateWindowRequest = {
			sessionIds: ['session-1'],
			activeSessionId: 'session-1',
			bounds: {
				x: 100,
				y: 100,
				width: 1000,
				height: 800,
			},
		};

		expect(request.sessionIds).toEqual(['session-1']);
		expect(request.activeSessionId).toBe('session-1');
		expect(request.bounds?.x).toBe(100);
		expect(request.bounds?.y).toBe(100);
		expect(request.bounds?.width).toBe(1000);
		expect(request.bounds?.height).toBe(800);
	});

	it('should allow creating a minimal request', () => {
		const request: CreateWindowRequest = {};

		expect(request.sessionIds).toBeUndefined();
		expect(request.activeSessionId).toBeUndefined();
		expect(request.bounds).toBeUndefined();
	});

	it('should allow partial bounds', () => {
		const request: CreateWindowRequest = {
			bounds: {
				width: 1200,
				height: 800,
			},
		};

		expect(request.bounds?.x).toBeUndefined();
		expect(request.bounds?.y).toBeUndefined();
		expect(request.bounds?.width).toBe(1200);
		expect(request.bounds?.height).toBe(800);
	});
});

describe('CreateWindowResponse', () => {
	it('should contain the window ID', () => {
		const response: CreateWindowResponse = {
			windowId: 'new-window-123',
		};

		expect(response.windowId).toBe('new-window-123');
	});
});

describe('MoveSessionRequest', () => {
	it('should allow creating a full move request', () => {
		const request: MoveSessionRequest = {
			sessionId: 'session-1',
			fromWindowId: 'window-1',
			toWindowId: 'window-2',
		};

		expect(request.sessionId).toBe('session-1');
		expect(request.fromWindowId).toBe('window-1');
		expect(request.toWindowId).toBe('window-2');
	});

	it('should allow fromWindowId to be undefined for adding to window', () => {
		const request: MoveSessionRequest = {
			sessionId: 'session-1',
			toWindowId: 'window-2',
		};

		expect(request.sessionId).toBe('session-1');
		expect(request.fromWindowId).toBeUndefined();
		expect(request.toWindowId).toBe('window-2');
	});
});

describe('Constants', () => {
	it('should have default window bounds', () => {
		expect(DEFAULT_WINDOW_BOUNDS.width).toBe(1200);
		expect(DEFAULT_WINDOW_BOUNDS.height).toBe(800);
	});

	it('should have minimum window bounds', () => {
		expect(MIN_WINDOW_BOUNDS.width).toBe(800);
		expect(MIN_WINDOW_BOUNDS.height).toBe(600);
	});

	it('should have default bounds larger than minimum', () => {
		expect(DEFAULT_WINDOW_BOUNDS.width).toBeGreaterThanOrEqual(MIN_WINDOW_BOUNDS.width);
		expect(DEFAULT_WINDOW_BOUNDS.height).toBeGreaterThanOrEqual(MIN_WINDOW_BOUNDS.height);
	});
});
