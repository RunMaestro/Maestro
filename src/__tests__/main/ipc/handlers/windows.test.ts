import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

import { registerWindowsHandlers } from '../../../../main/ipc/handlers/windows';
import type { PersistedWindowState } from '../../../../shared/types/window';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: {
		fromWebContents: vi.fn(),
	},
}));

function createPersistedWindowState(
	id: string,
	sessionIds: string[] = []
): PersistedWindowState {
	return {
		id,
		x: 0,
		y: 0,
		width: 1280,
		height: 800,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [...sessionIds],
		activeSessionId: sessionIds[0] ?? null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
}

function createMockWindowStateStore(initialWindows: PersistedWindowState[]) {
	const initialState = {
		multiWindowState: {
			primaryWindowId: initialWindows[0]?.id ?? 'primary',
			windows: initialWindows.map((window) => ({ ...window, sessionIds: [...window.sessionIds] })),
		},
		width: 1280,
		height: 800,
		isMaximized: false,
		isFullScreen: false,
	};

	return {
		store: initialState,
		get: vi.fn((key: string) => initialState[key as keyof typeof initialState]),
		set: vi.fn((key: string, value: any) => {
			(initialState as any)[key] = value;
			if (key === 'multiWindowState') {
				initialState.multiWindowState = value;
			}
		}),
	};
}

function createMockBrowserWindow() {
	return {
		isDestroyed: vi.fn().mockReturnValue(false),
		webContents: {
			isDestroyed: vi.fn().mockReturnValue(false),
			send: vi.fn(),
		},
	};
}

function createMockWindowRegistry(initialSessions: Record<string, string[]>) {
	const windows = new Map(
		Object.entries(initialSessions).map(([windowId, sessionIds]) => [
			windowId,
			{
				windowId,
				browserWindow: createMockBrowserWindow(),
				sessionIds: [...sessionIds],
				isMain: windowId === Object.keys(initialSessions)[0],
			},
		])
	);

	const moveSession = vi.fn((sessionId: string, fromWindowId: string, toWindowId: string) => {
		const fromEntry = windows.get(fromWindowId);
		const toEntry = windows.get(toWindowId);

		if (!fromEntry || !toEntry) {
			throw new Error('Invalid window id provided for moving session');
		}

		fromEntry.sessionIds = fromEntry.sessionIds.filter((id) => id !== sessionId);

		if (!toEntry.sessionIds.includes(sessionId)) {
			toEntry.sessionIds = [...toEntry.sessionIds, sessionId];
		}
	});

	return {
		registry: {
			get: vi.fn((windowId: string) => windows.get(windowId)),
			getAll: vi.fn(() => Array.from(windows.values())),
			getWindowForSession: vi.fn((sessionId: string) => {
				for (const entry of windows.values()) {
					if (entry.sessionIds.includes(sessionId)) {
						return entry.windowId;
					}
				}
				return undefined;
			}),
			moveSession,
		} as any,
		moveSession,
		windows,
	};
}

describe('windows IPC handlers', () => {
	let handlers: Map<string, (event: any, ...args: any[]) => any>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
	});

	it('re-resolves the source window when moveSession requests race', async () => {
		const registry = createMockWindowRegistry({
			'window-primary': ['session-1'],
			'window-b': [],
			'window-c': [],
		});
		const stateStore = createMockWindowStateStore([
			createPersistedWindowState('window-primary', ['session-1']),
			createPersistedWindowState('window-b'),
			createPersistedWindowState('window-c'),
		]);

		registerWindowsHandlers({
			getWindowManager: () => ({}) as any,
			getWindowRegistry: () => registry.registry,
			windowStateStore: stateStore as any,
		});

		const handler = handlers.get('windows:moveSession');
		if (!handler) {
			throw new Error('moveSession handler not registered');
		}

		await handler({} as any, {
			sessionId: 'session-1',
			toWindowId: 'window-b',
			fromWindowId: 'window-primary',
		});

		await handler({} as any, {
			sessionId: 'session-1',
			toWindowId: 'window-c',
			fromWindowId: 'window-primary',
		});

		expect(registry.moveSession).toHaveBeenNthCalledWith(1, 'session-1', 'window-primary', 'window-b');
		expect(registry.moveSession).toHaveBeenNthCalledWith(2, 'session-1', 'window-b', 'window-c');

		const persistedWindows = stateStore.store.multiWindowState.windows;
		expect(persistedWindows.find((window) => window.id === 'window-b')?.sessionIds).toEqual([]);
		expect(persistedWindows.find((window) => window.id === 'window-c')?.sessionIds).toEqual([
			'session-1',
		]);
	});
});
