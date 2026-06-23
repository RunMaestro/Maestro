/**
 * Tests for window-state-persistence - the bridge between the live
 * WindowRegistry and the persisted MultiWindowState in the window-state store.
 *
 * The real WindowRegistry is used (it is a pure module) with minimal fake
 * BrowserWindow objects exposing only the getters the conversion reads. The
 * store is a `{ set }` spy; the logger is mocked so a save failure logs rather
 * than throwing through cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import type Store from 'electron-store';
import type { WindowState as WindowStateStoreData } from '../stores/types';
import { WindowRegistry } from '../window-registry';
import {
	buildMultiWindowState,
	registeredWindowToWindowState,
	saveAllWindowStates,
	saveWindowState,
} from '../window-state-persistence';

// Hoisted so the mock factory can reference it: the static import of the module
// under test is hoisted above the test body, so a plain `const` would still be
// in its TDZ when the factory runs.
const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logger: mockLogger }));

/** A fake BrowserWindow exposing only what the persistence helpers touch. */
function makeWindow(
	opts: {
		bounds?: { x: number; y: number; width: number; height: number };
		isMaximized?: boolean;
		isFullScreen?: boolean;
		destroyed?: boolean;
	} = {}
): BrowserWindow {
	const {
		bounds = { x: 0, y: 0, width: 800, height: 600 },
		isMaximized = false,
		isFullScreen = false,
		destroyed = false,
	} = opts;
	return {
		getBounds: vi.fn(() => bounds),
		isMaximized: vi.fn(() => isMaximized),
		isFullScreen: vi.fn(() => isFullScreen),
		isDestroyed: vi.fn(() => destroyed),
	} as unknown as BrowserWindow;
}

/** A fake window-state store whose `set` is a spy. */
function makeStore(): Store<WindowStateStoreData> & { set: ReturnType<typeof vi.fn> } {
	return { set: vi.fn() } as unknown as Store<WindowStateStoreData> & {
		set: ReturnType<typeof vi.fn>;
	};
}

describe('window-state-persistence', () => {
	let registry: WindowRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new WindowRegistry();
	});

	describe('registeredWindowToWindowState', () => {
		it('maps bounds, display mode, sessions, and panel state', () => {
			registry.create({
				windowId: 'w1',
				browserWindow: makeWindow({
					bounds: { x: 10, y: 20, width: 1200, height: 800 },
					isMaximized: true,
				}),
				sessionIds: ['a', 'b'],
				isMain: true,
			});
			registry.setPanelState('w1', { leftPanelCollapsed: true, rightPanelCollapsed: false });

			const state = registeredWindowToWindowState(registry.get('w1')!);

			expect(state).toEqual({
				id: 'w1',
				x: 10,
				y: 20,
				width: 1200,
				height: 800,
				isMaximized: true,
				isFullScreen: false,
				sessionIds: ['a', 'b'],
				activeSessionId: null,
				leftPanelCollapsed: true,
				rightPanelCollapsed: false,
			});
		});

		it('copies sessionIds so the persisted snapshot does not alias the registry', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow(), sessionIds: ['a'] });
			const state = registeredWindowToWindowState(registry.get('w1')!);
			registry.setSessionsForWindow('w1', ['a', 'b']);
			expect(state.sessionIds).toEqual(['a']);
		});
	});

	describe('buildMultiWindowState', () => {
		it('snapshots every live window and points primaryWindowId at the main window', () => {
			registry.create({
				windowId: 'secondary',
				browserWindow: makeWindow({ bounds: { x: 5, y: 5, width: 600, height: 400 } }),
				sessionIds: ['s1'],
				isMain: false,
			});
			registry.create({
				windowId: 'primary',
				browserWindow: makeWindow({ bounds: { x: 0, y: 0, width: 1000, height: 700 } }),
				sessionIds: ['s2', 's3'],
				isMain: true,
			});

			const result = buildMultiWindowState(registry);

			expect(result.primaryWindowId).toBe('primary');
			expect(result.windows.map((w) => w.id)).toEqual(['secondary', 'primary']);
			expect(result.windows.find((w) => w.id === 'primary')?.sessionIds).toEqual(['s2', 's3']);
		});

		it('skips destroyed windows', () => {
			registry.create({
				windowId: 'dead',
				browserWindow: makeWindow({ destroyed: true }),
				isMain: false,
			});
			registry.create({ windowId: 'live', browserWindow: makeWindow(), isMain: true });

			const result = buildMultiWindowState(registry);

			expect(result.windows.map((w) => w.id)).toEqual(['live']);
			expect(result.primaryWindowId).toBe('live');
		});

		it('falls back to the first window when none is flagged primary', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow(), isMain: false });
			registry.create({ windowId: 'w2', browserWindow: makeWindow(), isMain: false });

			const result = buildMultiWindowState(registry);

			expect(result.primaryWindowId).toBe('w1');
		});

		it('returns an empty layout with no live windows', () => {
			const result = buildMultiWindowState(registry);
			expect(result).toEqual({ windows: [], primaryWindowId: '' });
		});
	});

	describe('saveAllWindowStates', () => {
		it('writes the multi-window layout to the store under the multiWindow key', () => {
			const store = makeStore();
			registry.create({
				windowId: 'primary',
				browserWindow: makeWindow({ bounds: { x: 1, y: 2, width: 1000, height: 700 } }),
				sessionIds: ['s1'],
				isMain: true,
			});

			saveAllWindowStates(store, registry);

			expect(store.set).toHaveBeenCalledTimes(1);
			const [key, value] = store.set.mock.calls[0];
			expect(key).toBe('multiWindow');
			expect(value).toMatchObject({
				primaryWindowId: 'primary',
				windows: [expect.objectContaining({ id: 'primary', x: 1, y: 2, sessionIds: ['s1'] })],
			});
		});

		it('does not overwrite the persisted layout when no live windows remain', () => {
			const store = makeStore();
			// All windows closed (e.g. macOS app idling) - keep the last good layout.
			saveAllWindowStates(store, registry);
			expect(store.set).not.toHaveBeenCalled();
		});

		it('never throws when the store write fails - logs instead', () => {
			const store = makeStore();
			store.set.mockImplementation(() => {
				throw new Error('ENOSPC');
			});
			registry.create({ windowId: 'w1', browserWindow: makeWindow(), isMain: true });

			expect(() => saveAllWindowStates(store, registry)).not.toThrow();
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('Failed to save multi-window state'),
				expect.any(String),
				expect.any(Error)
			);
		});
	});

	describe('saveWindowState', () => {
		it('snapshots the full live layout when the triggering window exists', () => {
			const store = makeStore();
			registry.create({
				windowId: 'primary',
				browserWindow: makeWindow({ bounds: { x: 0, y: 0, width: 1000, height: 700 } }),
				sessionIds: ['s1'],
				isMain: true,
			});
			registry.create({
				windowId: 'secondary',
				browserWindow: makeWindow({ bounds: { x: 50, y: 60, width: 600, height: 400 } }),
				sessionIds: ['s2'],
				isMain: false,
			});

			// A move on the secondary persists the whole layout, not just that window.
			saveWindowState(store, registry, 'secondary');

			expect(store.set).toHaveBeenCalledTimes(1);
			const [key, value] = store.set.mock.calls[0];
			expect(key).toBe('multiWindow');
			expect(value.primaryWindowId).toBe('primary');
			expect(value.windows.map((w: { id: string }) => w.id)).toEqual(['primary', 'secondary']);
		});

		it('no-ops when the triggering window is unknown', () => {
			const store = makeStore();
			registry.create({ windowId: 'live', browserWindow: makeWindow(), isMain: true });

			saveWindowState(store, registry, 'ghost');

			expect(store.set).not.toHaveBeenCalled();
		});

		it('no-ops when the triggering window has been destroyed', () => {
			const store = makeStore();
			registry.create({
				windowId: 'dead',
				browserWindow: makeWindow({ destroyed: true }),
				isMain: true,
			});

			saveWindowState(store, registry, 'dead');

			expect(store.set).not.toHaveBeenCalled();
		});

		it('never throws when the store write fails - logs instead', () => {
			const store = makeStore();
			store.set.mockImplementation(() => {
				throw new Error('ENOSPC');
			});
			registry.create({ windowId: 'w1', browserWindow: makeWindow(), isMain: true });

			expect(() => saveWindowState(store, registry, 'w1')).not.toThrow();
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('Failed to save multi-window state'),
				expect.any(String),
				expect.any(Error)
			);
		});
	});
});
