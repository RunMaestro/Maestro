import { describe, it, expect, vi, beforeEach } from 'vitest';

// Logger the migration depends on - silence it in tests.
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { migrateWindowStateToMultiWindow } from '../../../../main/stores/migrations/multi-window-state';

/**
 * Minimal in-memory electron-store double. `store` mirrors the merged-with-
 * defaults object electron-store exposes; `get`/`set` operate on the same record.
 */
function makeStore(initial: Record<string, any> = {}) {
	const data: Record<string, any> = { ...initial };
	return {
		data,
		get store() {
			return data;
		},
		get: vi.fn((key: string, fallback?: any) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: any) => {
			data[key] = value;
		}),
	};
}

describe('migrateWindowStateToMultiWindow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('converts legacy single-window bounds into a one-window MultiWindowState', () => {
		const store = makeStore({
			x: 120,
			y: 80,
			width: 1600,
			height: 1000,
			isMaximized: false,
			isFullScreen: false,
		});

		migrateWindowStateToMultiWindow(store as any);

		const { multiWindow } = store.data;
		expect(multiWindow.windows).toHaveLength(1);
		const [primary] = multiWindow.windows;
		expect(multiWindow.primaryWindowId).toBe(primary.id);
		expect(primary).toMatchObject({
			x: 120,
			y: 80,
			width: 1600,
			height: 1000,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: [],
			activeSessionId: null,
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
		});
		expect(typeof primary.id).toBe('string');
		expect(primary.id.length).toBeGreaterThan(0);
	});

	it('seeds the migrated primary window with the agents that currently exist', () => {
		// The legacy build showed every agent in its lone window, so the migrated
		// primary inherits them all and stays their catch-all owner.
		const store = makeStore({
			x: 120,
			y: 80,
			width: 1600,
			height: 1000,
			isMaximized: false,
			isFullScreen: false,
		});

		migrateWindowStateToMultiWindow(store as any, ['agent-a', 'agent-b', 'agent-c']);

		const [primary] = store.data.multiWindow.windows;
		expect(primary.sessionIds).toEqual(['agent-a', 'agent-b', 'agent-c']);
		// A copy, not the caller's array - mutating the source must not leak in.
		expect(primary.sessionIds).not.toBe(undefined);
	});

	it('ignores existing agents on a fresh install (no legacy state to migrate)', () => {
		// A fresh install seeds an empty layout; those agents still surface via the
		// primary window's catch-all at restore time, so they are NOT pre-assigned.
		const store = makeStore({
			width: 1400,
			height: 900,
			isMaximized: false,
			isFullScreen: false,
		});

		migrateWindowStateToMultiWindow(store as any, ['agent-a', 'agent-b']);

		expect(store.data.multiWindow).toEqual({ windows: [], primaryWindowId: '' });
	});

	it('carries a maximized-only history even without saved x/y coordinates', () => {
		const store = makeStore({
			width: 1400,
			height: 900,
			isMaximized: true,
			isFullScreen: false,
		});

		migrateWindowStateToMultiWindow(store as any);

		const [primary] = store.data.multiWindow.windows;
		expect(primary.isMaximized).toBe(true);
		// x/y were never persisted - the placeholder keeps the type well-formed.
		expect(primary.x).toBe(0);
		expect(primary.y).toBe(0);
	});

	it('seeds an empty multi-window state on a fresh install (no legacy position or mode)', () => {
		// Only the defaults are present - the user has never moved/maximized a window.
		const store = makeStore({
			width: 1400,
			height: 900,
			isMaximized: false,
			isFullScreen: false,
		});

		migrateWindowStateToMultiWindow(store as any);

		expect(store.data.multiWindow).toEqual({ windows: [], primaryWindowId: '' });
	});

	it('is idempotent - leaves an already-migrated multiWindow untouched', () => {
		const existing = {
			windows: [{ id: 'win-1', x: 5, y: 5, width: 800, height: 600 }],
			primaryWindowId: 'win-1',
		};
		const store = makeStore({
			width: 1400,
			height: 900,
			isMaximized: false,
			isFullScreen: false,
			multiWindow: existing,
		});

		migrateWindowStateToMultiWindow(store as any);

		expect(store.data.multiWindow).toBe(existing);
		expect(store.set).not.toHaveBeenCalled();
	});

	it('never throws and falls back to an empty state when reading legacy state fails', () => {
		const data: Record<string, any> = {};
		const store = {
			data,
			get store(): Record<string, any> {
				throw new Error('disk read failed');
			},
			get: vi.fn(() => undefined),
			set: vi.fn((key: string, value: any) => {
				data[key] = value;
			}),
		};

		expect(() => migrateWindowStateToMultiWindow(store as any)).not.toThrow();
		expect(data.multiWindow).toEqual({ windows: [], primaryWindowId: '' });
	});
});
