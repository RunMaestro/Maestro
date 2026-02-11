import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { WindowRegistry } from '../../main/window-registry';
import type { WindowState as PersistedWindowState } from '../../shared/types/window';

const defaultDisplay = {
	id: 1,
	workArea: { x: 0, y: 0, width: 1920, height: 1080 },
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
};

const mockGetDisplayMatching = vi.fn().mockReturnValue(defaultDisplay);

let nextBrowserWindowId = 1;

vi.mock('electron', () => {
	class MockBrowserWindow {
		id: number;
		webContents: { isDestroyed: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
		private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();
		isDestroyed = vi.fn().mockReturnValue(false);
		isMaximized = vi.fn().mockReturnValue(false);
		isFullScreen = vi.fn().mockReturnValue(false);
		getBounds = vi.fn(() => ({ x: 10, y: 20, width: 1280, height: 800 }));
		setFullScreen = vi.fn();
		maximize = vi.fn();
		on = vi.fn((event: string, handler: (...args: any[]) => void) => {
			const existing = this.listeners.get(event) ?? [];
			existing.push(handler);
			this.listeners.set(event, existing);
			return this;
		});

		constructor() {
			this.id = nextBrowserWindowId++;
			this.webContents = {
				isDestroyed: vi.fn().mockReturnValue(false),
				send: vi.fn(),
			};
		}

		emit(event: string, ...args: any[]): void {
			const handlers = this.listeners.get(event) ?? [];
			for (const handler of handlers) {
				handler(...args);
			}
		}
	}

	return {
		screen: {
			getDisplayMatching: (...args: unknown[]) => mockGetDisplayMatching(...args),
		},
		BrowserWindow: MockBrowserWindow,
	};
});

beforeEach(() => {
	nextBrowserWindowId = 1;
});

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

function createMockBrowserWindow(overrides: Partial<BrowserWindowType> = {}) {
	const instance = new (ElectronBrowserWindow as unknown as {
		new (): BrowserWindowType & { emit?: (...args: any[]) => void };
	})();
	Object.assign(instance, overrides);
	return instance as BrowserWindowType & { emit?: (...args: any[]) => void };
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

function createPersistedWindowState(
	id: string,
	sessionIds: string[] = [],
	overrides: Partial<PersistedWindowState> = {}
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
		...overrides,
	};
}

describe('WindowRegistry.saveWindowState', () => {
	let mockStore: MockStore;

	beforeEach(() => {
		mockStore = createMockStore();
		vi.useFakeTimers();
		mockGetDisplayMatching.mockReset();
		mockGetDisplayMatching.mockReturnValue(defaultDisplay);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createRegistry() {
		return new WindowRegistry({ windowStateStore: mockStore as any, saveDebounceMs: 25 });
	}

	function registerWindow(
		registry: WindowRegistry,
		windowId: string,
		overrides: Partial<BrowserWindowType> = {}
	) {
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
			displayId: defaultDisplay.id,
		});
	});

	it('retains persisted panel collapse state for each window', () => {
		mockStore.store.multiWindowState = {
			primaryWindowId: 'primary',
			windows: [
				createPersistedWindowState('primary', ['session-1'], {
					leftPanelCollapsed: true,
					rightPanelCollapsed: false,
				}),
			],
		};
		const registry = createRegistry();
		registerWindow(registry, 'primary');

		registry.saveWindowState('primary', { immediate: true });

		const savedStateCall = mockStore.set.mock.calls.find(([key]) => key === 'multiWindowState');
		const savedWindow = savedStateCall?.[1].windows[0];
		expect(savedWindow.leftPanelCollapsed).toBe(true);
		expect(savedWindow.rightPanelCollapsed).toBe(false);
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

describe('WindowRegistry session reassignment', () => {
	let mockStore: MockStore;
	let registry: WindowRegistry;

	beforeEach(() => {
		mockStore = createMockStore();
		registry = new WindowRegistry({ windowStateStore: mockStore as any, saveDebounceMs: 25 });
		mockGetDisplayMatching.mockReset();
		mockGetDisplayMatching.mockReturnValue(defaultDisplay);
	});

	function seedWindows(options: {
		primarySessions?: string[];
		secondarySessions?: string[];
		secondaryIsMain?: boolean;
	}) {
		const primarySessions = options.primarySessions ?? [];
		const secondarySessions = options.secondarySessions ?? [];
		const primaryWindow = createMockBrowserWindow();
		const secondaryWindow = createMockBrowserWindow();

		(registry as any).windows.set('primary', {
			browserWindow: primaryWindow,
			sessionIds: [...primarySessions],
			isMain: true,
		});
		(registry as any).windows.set('secondary', {
			browserWindow: secondaryWindow,
			sessionIds: [...secondarySessions],
			isMain: options.secondaryIsMain ?? false,
		});
		(registry as any).primaryWindowId = 'primary';

		mockStore.store.multiWindowState = {
			primaryWindowId: 'primary',
			windows: [
				createPersistedWindowState('primary', primarySessions),
				createPersistedWindowState('secondary', secondarySessions),
			],
		};

		return { primaryWindow, secondaryWindow };
	}

	it('moves sessions back to the primary window and broadcasts updates', () => {
		const { primaryWindow, secondaryWindow } = seedWindows({
			primarySessions: ['main-1'],
			secondarySessions: ['child-1', 'child-2'],
		});

		(registry as any).reassignSessionsToPrimary('secondary');

		const updatedPrimary = (registry as any).windows.get('primary');
		expect(updatedPrimary.sessionIds).toEqual(['main-1', 'child-1', 'child-2']);

		const savedStateCall = mockStore.set.mock.calls.find(([key]) => key === 'multiWindowState');
		const savedState = savedStateCall?.[1];
		expect(savedState.windows).toHaveLength(1);
		expect(savedState.windows[0]).toMatchObject({
			id: 'primary',
			sessionIds: ['main-1', 'child-1', 'child-2'],
		});

		expect(primaryWindow.webContents.send).toHaveBeenCalledWith(
			'windows:sessionMoved',
			expect.objectContaining({ sessionId: 'child-1', fromWindowId: 'secondary', toWindowId: 'primary' })
		);
		expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
			'windows:sessionMoved',
			expect.objectContaining({ sessionId: 'child-2', fromWindowId: 'secondary', toWindowId: 'primary' })
		);

		expect(primaryWindow.webContents.send).toHaveBeenCalledWith(
			'windows:sessionsReassigned',
			expect.objectContaining({
				fromWindowId: 'secondary',
				toWindowId: 'primary',
				sessionIds: ['child-1', 'child-2'],
			})
		);
	});

	it('ignores primary window closures', () => {
		const { primaryWindow } = seedWindows({ secondaryIsMain: true });

		(registry as any).reassignSessionsToPrimary('primary');

		expect(mockStore.set).not.toHaveBeenCalled();
		expect(primaryWindow.webContents.send).not.toHaveBeenCalled();
	});

	it('removes closed window state even with no sessions', () => {
		seedWindows({ primarySessions: [], secondarySessions: [] });

		(registry as any).reassignSessionsToPrimary('secondary');

		const savedStateCall = mockStore.set.mock.calls.find(([key]) => key === 'multiWindowState');
		const savedState = savedStateCall?.[1];
		expect(savedState.windows).toHaveLength(1);
		expect(savedState.windows[0].id).toBe('primary');
	});

	it('does not broadcast reassignment when there are no sessions to move', () => {
		const { primaryWindow } = seedWindows({ primarySessions: ['base'], secondarySessions: [] });

		(registry as any).reassignSessionsToPrimary('secondary');

		expect(primaryWindow.webContents.send).not.toHaveBeenCalledWith(
			'windows:sessionsReassigned',
			expect.anything()
		);
	});
});

describe('WindowRegistry window count analytics', () => {
	let mockStore: MockStore;

	beforeEach(() => {
		mockStore = createMockStore();
	});

	it('invokes callback when windows are added or removed', () => {
		const callback = vi.fn();
		const registry = new WindowRegistry({
			windowStateStore: mockStore as any,
			saveDebounceMs: 25,
			onWindowCountChanged: callback,
		});

		const primaryWindow = registry.create({ windowId: 'primary', sessionIds: ['session-1'] });
		expect(callback).toHaveBeenLastCalledWith({ windowCount: 1, sessionCount: 1 });

		callback.mockClear();
		const secondaryWindow = registry.create({
			windowId: 'secondary',
			sessionIds: ['session-1', 'session-2'],
		});
		expect(callback).toHaveBeenLastCalledWith({ windowCount: 2, sessionCount: 2 });

		callback.mockClear();
		(secondaryWindow as any).emit('closed');
		expect(callback).toHaveBeenLastCalledWith({ windowCount: 1, sessionCount: 1 });

		// Ensure duplicate sessions across windows are not double counted
		callback.mockClear();
		const tertiaryWindow = registry.create({
			windowId: 'tertiary',
			sessionIds: ['session-2'],
		});
		expect(callback).toHaveBeenLastCalledWith({ windowCount: 2, sessionCount: 2 });

		callback.mockClear();
		(tertiaryWindow as any).emit('closed');
		expect(callback).toHaveBeenLastCalledWith({ windowCount: 1, sessionCount: 1 });

		callback.mockClear();
		(primaryWindow as any).emit('closed');
		expect(callback).toHaveBeenLastCalledWith({ windowCount: 0, sessionCount: 0 });
	});
});
