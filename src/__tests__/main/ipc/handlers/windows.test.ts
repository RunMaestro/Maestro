/**
 * Tests for the multi-window IPC handlers.
 *
 * Tests cover:
 * - Handler registration with ipcMain.handle
 * - Delegation to the WindowRegistry (list, getForSession, moveSession,
 *   findWindowAtPoint) and the window manager (create)
 * - Refusal to close the primary window
 * - Resolving the calling window from event.sender (getState / getBounds)
 * - "not initialized" errors when the registry/manager are not wired
 *
 * The real WindowRegistry is used (it is a pure module) with cast-mock
 * BrowserWindow objects, matching the window-registry.test.ts convention. The
 * ipcHandler helpers are mocked so withIpcErrorLogging strips the event and
 * requireDependency throws on a null dependency, mirroring the real behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
	BrowserWindow: {
		fromWebContents: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging:
		(_opts: unknown, handler: (...args: unknown[]) => unknown) =>
		(_event: unknown, ...args: unknown[]) =>
			handler(...args),
	requireDependency: (getter: () => unknown, name: string) => {
		const dep = getter();
		if (!dep) throw new Error(`${name} not initialized`);
		return dep;
	},
}));

import { registerWindowsHandlers } from '../../../../main/ipc/handlers/windows';
import { WindowRegistry } from '../../../../main/window-registry';

/** Build a cast-mock BrowserWindow with the surface the handlers touch. */
function makeFakeWindow(overrides: Partial<Record<string, unknown>> = {}): BrowserWindow {
	return {
		getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
		isMaximized: vi.fn(() => false),
		isFullScreen: vi.fn(() => false),
		isDestroyed: vi.fn(() => false),
		isMinimized: vi.fn(() => false),
		restore: vi.fn(),
		focus: vi.fn(),
		close: vi.fn(),
		...overrides,
	} as unknown as BrowserWindow;
}

/** A fake IPC invoke event whose sender resolves to `browserWindow`. */
function makeEvent(browserWindow: BrowserWindow | null) {
	vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(browserWindow as never);
	return { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent;
}

describe('Windows IPC Handlers', () => {
	let registry: WindowRegistry;
	let handlers: Map<string, Function>;
	let createSecondaryWindow: ReturnType<typeof vi.fn>;

	function register(opts: { withRegistry?: boolean; withManager?: boolean } = {}) {
		const { withRegistry = true, withManager = true } = opts;
		registerWindowsHandlers({
			getWindowRegistry: () => (withRegistry ? registry : null),
			getWindowManager: () => (withManager ? ({ createSecondaryWindow } as never) : null),
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new WindowRegistry();
		handlers = new Map();
		createSecondaryWindow = vi.fn();

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		register();
	});

	describe('handler registration', () => {
		it('registers every windows:* handler', () => {
			for (const channel of [
				'windows:create',
				'windows:close',
				'windows:list',
				'windows:getForSession',
				'windows:moveSession',
				'windows:focusWindow',
				'windows:getState',
				'windows:getBounds',
				'windows:findWindowAtPoint',
			]) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('windows:create', () => {
		it('builds a secondary window via the manager and returns its info', async () => {
			const win = makeFakeWindow();
			createSecondaryWindow.mockImplementation((sessionIds: string[]) => {
				registry.create({ browserWindow: win, sessionIds, isMain: false });
				return win;
			});

			const result = (await handlers.get('windows:create')!({}, ['agent-1'], undefined)) as {
				id: string;
				isMain: boolean;
				sessionIds: string[];
				activeSessionId: string | null;
			} | null;

			expect(createSecondaryWindow).toHaveBeenCalledWith(['agent-1'], undefined);
			expect(result).not.toBeNull();
			expect(result!.isMain).toBe(false);
			expect(result!.sessionIds).toEqual(['agent-1']);
			expect(result!.activeSessionId).toBeNull();
			expect(typeof result!.id).toBe('string');
		});

		it('defaults to no sessions when none are passed', async () => {
			const win = makeFakeWindow();
			createSecondaryWindow.mockImplementation((sessionIds: string[]) => {
				registry.create({ browserWindow: win, sessionIds, isMain: false });
				return win;
			});

			await handlers.get('windows:create')!({});

			expect(createSecondaryWindow).toHaveBeenCalledWith([], undefined);
		});

		it('returns null when the created window is not tracked by the registry', async () => {
			createSecondaryWindow.mockReturnValue(makeFakeWindow());

			const result = await handlers.get('windows:create')!({}, ['agent-1']);

			expect(result).toBeNull();
		});
	});

	describe('windows:close', () => {
		it('refuses to close the primary window', async () => {
			const primary = makeFakeWindow();
			const id = registry.create({ browserWindow: primary, sessionIds: [], isMain: true });

			const result = (await handlers.get('windows:close')!({}, id)) as {
				closed: boolean;
				error?: string;
			};

			expect(result.closed).toBe(false);
			expect(result.error).toMatch(/primary/i);
			expect(primary.close).not.toHaveBeenCalled();
		});

		it('closes a secondary window', async () => {
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			const result = (await handlers.get('windows:close')!({}, id)) as { closed: boolean };

			expect(result.closed).toBe(true);
			expect(win.close).toHaveBeenCalled();
		});

		it('reports when the window is not found', async () => {
			const result = (await handlers.get('windows:close')!({}, 'missing')) as {
				closed: boolean;
				error?: string;
			};

			expect(result.closed).toBe(false);
			expect(result.error).toMatch(/not found/i);
		});
	});

	describe('windows:list', () => {
		it('returns a WindowInfo for every registered window', async () => {
			registry.create({ browserWindow: makeFakeWindow(), sessionIds: ['a'], isMain: true });
			registry.create({ browserWindow: makeFakeWindow(), sessionIds: ['b', 'c'], isMain: false });

			const result = (await handlers.get('windows:list')!({})) as Array<{
				isMain: boolean;
				sessionIds: string[];
				activeSessionId: string | null;
			}>;

			expect(result).toHaveLength(2);
			expect(result[0].isMain).toBe(true);
			expect(result[1].sessionIds).toEqual(['b', 'c']);
			expect(result[0].activeSessionId).toBeNull();
		});
	});

	describe('windows:getForSession', () => {
		it('returns the owning window id', async () => {
			const id = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: ['agent-x'],
				isMain: false,
			});

			const result = await handlers.get('windows:getForSession')!({}, 'agent-x');

			expect(result).toBe(id);
		});

		it('returns null when no window owns the session', async () => {
			const result = await handlers.get('windows:getForSession')!({}, 'nobody');
			expect(result).toBeNull();
		});
	});

	describe('windows:moveSession', () => {
		it('moves a session between windows', async () => {
			const from = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: ['agent-1'],
				isMain: true,
			});
			const to = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: [],
				isMain: false,
			});

			const result = (await handlers.get('windows:moveSession')!({}, 'agent-1', from, to)) as {
				moved: boolean;
			};

			expect(result.moved).toBe(true);
			expect(registry.getWindowForSession('agent-1')).toBe(to);
		});

		it('refuses to move when a window is unknown', async () => {
			const from = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: ['agent-1'],
				isMain: true,
			});

			const result = (await handlers.get('windows:moveSession')!(
				{},
				'agent-1',
				from,
				'missing'
			)) as { moved: boolean; error?: string };

			expect(result.moved).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('windows:focusWindow', () => {
		it('restores a minimized window and focuses it', async () => {
			const win = makeFakeWindow({ isMinimized: vi.fn(() => true) });
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			const result = (await handlers.get('windows:focusWindow')!({}, id)) as { focused: boolean };

			expect(result.focused).toBe(true);
			expect(win.restore).toHaveBeenCalled();
			expect(win.focus).toHaveBeenCalled();
		});

		it('reports when the window is not found', async () => {
			const result = (await handlers.get('windows:focusWindow')!({}, 'missing')) as {
				focused: boolean;
				error?: string;
			};

			expect(result.focused).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('windows:getState', () => {
		it('returns the calling window state resolved from event.sender', async () => {
			const win = makeFakeWindow({
				getBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
				isMaximized: vi.fn(() => true),
			});
			const id = registry.create({ browserWindow: win, sessionIds: ['agent-1'], isMain: false });

			const result = (await handlers.get('windows:getState')!(makeEvent(win))) as {
				id: string;
				x: number;
				width: number;
				isMaximized: boolean;
				sessionIds: string[];
				leftPanelCollapsed: boolean;
			} | null;

			expect(result).not.toBeNull();
			expect(result!.id).toBe(id);
			expect(result!.x).toBe(10);
			expect(result!.width).toBe(800);
			expect(result!.isMaximized).toBe(true);
			expect(result!.sessionIds).toEqual(['agent-1']);
			expect(result!.leftPanelCollapsed).toBe(false);
		});

		it('returns null when the calling window is not registered', async () => {
			const result = await handlers.get('windows:getState')!(makeEvent(makeFakeWindow()));
			expect(result).toBeNull();
		});
	});

	describe('windows:getBounds', () => {
		it('returns the calling window bounds by default', async () => {
			const win = makeFakeWindow({
				getBounds: vi.fn(() => ({ x: 5, y: 6, width: 300, height: 200 })),
			});
			registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			const result = await handlers.get('windows:getBounds')!(makeEvent(win));

			expect(result).toEqual({ x: 5, y: 6, width: 300, height: 200 });
		});

		it('returns the bounds of a specific window when an id is given', async () => {
			const target = makeFakeWindow({
				getBounds: vi.fn(() => ({ x: 99, y: 99, width: 100, height: 100 })),
			});
			const id = registry.create({ browserWindow: target, sessionIds: [], isMain: false });

			// The calling window resolves to something else; the id wins.
			const result = await handlers.get('windows:getBounds')!(makeEvent(makeFakeWindow()), id);

			expect(result).toEqual({ x: 99, y: 99, width: 100, height: 100 });
		});

		it('returns null when the window cannot be found', async () => {
			const result = await handlers.get('windows:getBounds')!(makeEvent(null), 'missing');
			expect(result).toBeNull();
		});
	});

	describe('windows:findWindowAtPoint', () => {
		it('delegates to the registry', async () => {
			const win = makeFakeWindow({
				getBounds: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 })),
			});
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			const inside = await handlers.get('windows:findWindowAtPoint')!({}, 50, 50);
			const outside = await handlers.get('windows:findWindowAtPoint')!({}, 500, 500);

			expect(inside).toBe(id);
			expect(outside).toBeNull();
		});
	});

	describe('when dependencies are not wired', () => {
		beforeEach(() => {
			handlers.clear();
			register({ withRegistry: false, withManager: false });
		});

		it('rejects windows:list with a not-initialized error', async () => {
			await expect(handlers.get('windows:list')!({})).rejects.toThrow(/not initialized/i);
		});

		it('rejects windows:create with a not-initialized error', async () => {
			await expect(handlers.get('windows:create')!({}, [])).rejects.toThrow(/not initialized/i);
		});
	});
});
