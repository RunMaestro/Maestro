import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

import { WindowRegistry } from '../../main/window-registry';

interface MockStore {
	store: Record<string, any> & {
		multiWindowState: {
			primaryWindowId: string;
			windows: any[];
		};
	};
	set: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
}

function createMockBrowserWindow(overrides: Partial<BrowserWindow> = {}) {
	const defaultBounds = { x: 10, y: 20, width: 1280, height: 800 };
	return {
		isDestroyed: vi.fn().mockReturnValue(false),
		isMaximized: vi.fn().mockReturnValue(false),
		isFullScreen: vi.fn().mockReturnValue(false),
		getBounds: vi.fn().mockReturnValue(defaultBounds),
		on: vi.fn(),
		...overrides,
	} as unknown as BrowserWindow;
}

function createMockStore(): MockStore {
	const initialState = {
		width: 1400,
		height: 900,
		isMaximized: false,
		isFullScreen: false,
		multiWindowState: {
			primaryWindowId: 'primary',
			windows: [],
		},
	};

	const store: MockStore = {
		store: initialState,
		set: vi.fn((key: string, value: any) => {
			store.store[key] = value;
			if (key === 'multiWindowState') {
				store.store.multiWindowState = value;
			}
		}),
		get: vi.fn((key: string) => store.store[key]),
	};

	return store;
}

describe('WindowRegistry.saveWindowState', () => {
	let mockStore: MockStore;

	beforeEach(() => {
		mockStore = createMockStore();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createRegistry() {
		return new WindowRegistry({ windowStateStore: mockStore as any, saveDebounceMs: 25 });
	}

	function registerWindow(registry: WindowRegistry, windowId: string, overrides: Partial<BrowserWindow> = {}) {
		const browserWindow = createMockBrowserWindow(overrides);
		(registry as any).windows.set(windowId, {
			browserWindow,
			sessionIds: ['session-1'],
			isMain: true,
		});
		return browserWindow;
	}

	it('persists bounds immediately when requested', () => {
		const registry = createRegistry();
		registerWindow(registry, 'primary');

		registry.saveWindowState('primary', { immediate: true });

		const multiWindowStateCalls = mockStore.set.mock.calls.filter(([key]) => key === 'multiWindowState');
		expect(multiWindowStateCalls).toHaveLength(1);
		const savedState = multiWindowStateCalls[0][1];
		expect(savedState.windows[0]).toMatchObject({
			id: 'primary',
			x: 10,
			y: 20,
			width: 1280,
			height: 800,
			isMaximized: false,
			isFullScreen: false,
			activeSessionId: 'session-1',
		});
	});

	it('debounces repeated save requests', () => {
		const registry = createRegistry();
		registerWindow(registry, 'primary');

		registry.saveWindowState('primary');
		registry.saveWindowState('primary');

		expect(mockStore.set).not.toHaveBeenCalledWith('multiWindowState', expect.anything());

		vi.runAllTimers();

		const multiWindowStateCalls = mockStore.set.mock.calls.filter(([key]) => key === 'multiWindowState');
		expect(multiWindowStateCalls).toHaveLength(1);
	});
});
