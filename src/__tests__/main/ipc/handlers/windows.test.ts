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

import {
	registerWindowsHandlers,
	wireWindowRegistryBroadcast,
	wireEmptySecondaryWindowAutoClose,
} from '../../../../main/ipc/handlers/windows';
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
		// webContents.send is the broadcast surface wireWindowRegistryBroadcast uses.
		webContents: {
			send: vi.fn(),
			isDestroyed: vi.fn(() => false),
		},
		...overrides,
	} as unknown as BrowserWindow;
}

/** The mocked webContents.send for a fake window, typed for assertions. */
function sendOf(win: BrowserWindow): ReturnType<typeof vi.fn> {
	return (win as unknown as { webContents: { send: ReturnType<typeof vi.fn> } }).webContents.send;
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
				'windows:registerSession',
				'windows:setPanelState',
				'windows:getBounds',
				'windows:findWindowAtPoint',
				'windows:highlightDropZone',
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

		it('returns null (not a throw) for a senderless bridge event', async () => {
			// The web-desktop bridge dispatches invokes with a synthetic event that
			// has no sender (FAKE_EVENT). getState must resolve to null so the web
			// client's WindowContext hydrate degrades gracefully instead of the
			// handler crashing on BrowserWindow.fromWebContents(undefined).
			const bridgeEvent = {
				senderFrame: null,
				frameId: -1,
				processId: -1,
				type: 'bridge',
			} as unknown as Electron.IpcMainInvokeEvent;
			const result = await handlers.get('windows:getState')!(bridgeEvent);
			expect(result).toBeNull();
		});

		it('reflects panel state persisted via windows:setPanelState', async () => {
			const win = makeFakeWindow();
			registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			// Defaults to expanded panels before any write.
			const before = (await handlers.get('windows:getState')!(makeEvent(win))) as {
				leftPanelCollapsed: boolean;
				rightPanelCollapsed: boolean;
			};
			expect(before.leftPanelCollapsed).toBe(false);
			expect(before.rightPanelCollapsed).toBe(false);

			await handlers.get('windows:setPanelState')!(makeEvent(win), {
				leftPanelCollapsed: true,
				rightPanelCollapsed: true,
			});

			const after = (await handlers.get('windows:getState')!(makeEvent(win))) as {
				leftPanelCollapsed: boolean;
				rightPanelCollapsed: boolean;
			};
			expect(after.leftPanelCollapsed).toBe(true);
			expect(after.rightPanelCollapsed).toBe(true);
		});
	});

	describe('windows:registerSession', () => {
		it('claims a new agent for the calling window resolved from event.sender', async () => {
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			const result = (await handlers.get('windows:registerSession')!(
				makeEvent(win),
				'agent-new'
			)) as { registered: boolean };

			expect(result.registered).toBe(true);
			expect(registry.get(id)?.sessionIds).toEqual(['agent-new']);
			expect(registry.getWindowForSession('agent-new')).toBe(id);
		});

		it('strips the agent from any other window (single ownership)', async () => {
			// The agent was somehow owned elsewhere (e.g. a stale claim); registering
			// it into the calling window must leave it owned by exactly that window.
			const primary = makeFakeWindow();
			const secondary = makeFakeWindow();
			const primaryId = registry.create({
				browserWindow: primary,
				sessionIds: ['agent-x'],
				isMain: true,
			});
			const secondaryId = registry.create({
				browserWindow: secondary,
				sessionIds: [],
				isMain: false,
			});

			await handlers.get('windows:registerSession')!(makeEvent(secondary), 'agent-x');

			expect(registry.get(primaryId)?.sessionIds).toEqual([]);
			expect(registry.get(secondaryId)?.sessionIds).toEqual(['agent-x']);
			expect(registry.getWindowForSession('agent-x')).toBe(secondaryId);
		});

		it('is a no-op (registered=false) when the calling window is not registered', async () => {
			const result = (await handlers.get('windows:registerSession')!(
				makeEvent(makeFakeWindow()),
				'agent-new'
			)) as { registered: boolean };

			expect(result.registered).toBe(false);
			expect(registry.getWindowForSession('agent-new')).toBeNull();
		});
	});

	describe('windows:setPanelState', () => {
		it('persists only the provided fields (partial merge)', async () => {
			const win = makeFakeWindow();
			registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			await handlers.get('windows:setPanelState')!(makeEvent(win), { leftPanelCollapsed: true });
			await handlers.get('windows:setPanelState')!(makeEvent(win), { rightPanelCollapsed: true });
			// A later partial write must not reset the field it omits.
			await handlers.get('windows:setPanelState')!(makeEvent(win), { rightPanelCollapsed: false });

			const state = (await handlers.get('windows:getState')!(makeEvent(win))) as {
				leftPanelCollapsed: boolean;
				rightPanelCollapsed: boolean;
			};
			expect(state.leftPanelCollapsed).toBe(true);
			expect(state.rightPanelCollapsed).toBe(false);
		});

		it('is a no-op when the calling window is not registered', () => {
			// An unregistered caller resolves to no window, so nothing is written and
			// nothing throws.
			expect(() =>
				handlers.get('windows:setPanelState')!(makeEvent(makeFakeWindow()), {
					leftPanelCollapsed: true,
				})
			).not.toThrow();
		});
	});

	describe('windows:setName', () => {
		it('renames the named window and reflects it in getState', async () => {
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			// withIpcErrorLogging-wrapped handler: called as (event, ...args).
			const result = (await handlers.get('windows:setName')!({}, id, 'Deploy Watch')) as {
				renamed: boolean;
			};
			expect(result.renamed).toBe(true);

			const state = (await handlers.get('windows:getState')!(makeEvent(win))) as { name?: string };
			expect(state.name).toBe('Deploy Watch');
		});

		it('returns { renamed: false } for an unknown window', async () => {
			const result = (await handlers.get('windows:setName')!({}, 'nope', 'X')) as {
				renamed: boolean;
			};
			expect(result.renamed).toBe(false);
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

	describe('windows:highlightDropZone', () => {
		it('pushes the toggle only to the target window', async () => {
			const target = makeFakeWindow();
			const other = makeFakeWindow();
			const id = registry.create({ browserWindow: target, sessionIds: [], isMain: true });
			registry.create({ browserWindow: other, sessionIds: [], isMain: false });

			await handlers.get('windows:highlightDropZone')!({}, id, true);

			expect(sendOf(target)).toHaveBeenCalledWith('windows:highlightDropZone', {
				windowId: id,
				active: true,
			});
			// Only the hovered window hears it - this is not a broadcast.
			expect(sendOf(other)).not.toHaveBeenCalled();
		});

		it('forwards the clear (active=false) toggle', async () => {
			const target = makeFakeWindow();
			const id = registry.create({ browserWindow: target, sessionIds: [], isMain: false });

			await handlers.get('windows:highlightDropZone')!({}, id, false);

			expect(sendOf(target)).toHaveBeenCalledWith('windows:highlightDropZone', {
				windowId: id,
				active: false,
			});
		});

		it('is a no-op for an unknown window', async () => {
			await expect(
				handlers.get('windows:highlightDropZone')!({}, 'missing', true)
			).resolves.toBeUndefined();
		});

		it('skips a destroyed window without sending', async () => {
			const win = makeFakeWindow({ isDestroyed: vi.fn(() => true) });
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: false });

			await handlers.get('windows:highlightDropZone')!({}, id, true);

			expect(sendOf(win)).not.toHaveBeenCalled();
		});
	});

	describe('wireWindowRegistryBroadcast', () => {
		it('broadcasts a session move to every window with the change payload', () => {
			const fromWin = makeFakeWindow();
			const toWin = makeFakeWindow();
			const from = registry.create({
				browserWindow: fromWin,
				sessionIds: ['agent-1'],
				isMain: true,
			});
			const to = registry.create({ browserWindow: toWin, sessionIds: [], isMain: false });

			// Wire AFTER creating windows so the 'created' events are not in scope.
			wireWindowRegistryBroadcast(registry);
			registry.moveSession('agent-1', from, to);

			const payload = {
				type: 'session-moved',
				sessionId: 'agent-1',
				fromWindowId: from,
				toWindowId: to,
				windowId: undefined,
			};
			expect(sendOf(fromWin)).toHaveBeenCalledWith('windows:sessionMoved', payload);
			expect(sendOf(toWin)).toHaveBeenCalledWith('windows:sessionMoved', payload);
		});

		it('broadcasts a sessions-changed (setSessionsForWindow) replacement', () => {
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: ['a'], isMain: true });

			wireWindowRegistryBroadcast(registry);
			registry.setSessionsForWindow(id, ['a', 'b']);

			expect(sendOf(win)).toHaveBeenCalledWith('windows:sessionMoved', {
				type: 'sessions-changed',
				windowId: id,
				sessionId: undefined,
				fromWindowId: undefined,
				toWindowId: undefined,
			});
		});

		it('does not broadcast on window create (a new empty window changes nothing)', () => {
			const win = makeFakeWindow();
			registry.create({ browserWindow: win, sessionIds: [], isMain: true });

			wireWindowRegistryBroadcast(registry);
			// A second create is not a change any renderer needs to react to (the
			// agent it will own arrives via a following session-moved).
			registry.create({ browserWindow: makeFakeWindow(), sessionIds: [], isMain: false });

			expect(sendOf(win)).not.toHaveBeenCalled();
		});

		it('broadcasts a window removal so the closed window vanishes from every list', () => {
			// A closed window must disappear from the "Move to Window" menu, so its
			// removal is broadcast to the remaining (primary) window.
			const primaryWin = makeFakeWindow();
			registry.create({ browserWindow: primaryWin, sessionIds: ['a'], isMain: true });
			const secondaryId = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: [],
				isMain: false,
			});

			wireWindowRegistryBroadcast(registry);
			registry.remove(secondaryId);

			expect(sendOf(primaryWin)).toHaveBeenCalledWith('windows:sessionMoved', {
				type: 'removed',
				windowId: secondaryId,
				sessionId: undefined,
				fromWindowId: undefined,
				toWindowId: undefined,
			});
		});

		it('broadcasts a window rename so every renderer refreshes its labels', () => {
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: true });

			wireWindowRegistryBroadcast(registry);
			registry.setName(id, 'Deploy Watch');

			expect(sendOf(win)).toHaveBeenCalledWith('windows:sessionMoved', {
				type: 'name-changed',
				windowId: id,
				sessionId: undefined,
				fromWindowId: undefined,
				toWindowId: undefined,
			});
		});

		it('does NOT broadcast a panel-collapse change (window-local UI)', () => {
			// panel-changed persists to disk but must never reach other renderers -
			// each window owns its own collapse state and would fight a pushed value.
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: [], isMain: true });

			wireWindowRegistryBroadcast(registry);
			registry.setPanelState(id, { leftPanelCollapsed: true });

			expect(sendOf(win)).not.toHaveBeenCalled();
		});

		it('skips destroyed windows and destroyed webContents', () => {
			const live = makeFakeWindow();
			const destroyedWin = makeFakeWindow({ isDestroyed: vi.fn(() => true) });
			const deadContents = makeFakeWindow({
				webContents: { send: vi.fn(), isDestroyed: vi.fn(() => true) },
			});
			const from = registry.create({ browserWindow: live, sessionIds: ['x'], isMain: true });
			const to = registry.create({ browserWindow: destroyedWin, sessionIds: [], isMain: false });
			registry.create({ browserWindow: deadContents, sessionIds: [], isMain: false });

			wireWindowRegistryBroadcast(registry);
			registry.moveSession('x', from, to);

			expect(sendOf(live)).toHaveBeenCalledTimes(1);
			expect(sendOf(destroyedWin)).not.toHaveBeenCalled();
			expect(sendOf(deadContents)).not.toHaveBeenCalled();
		});

		it('stops broadcasting after unsubscribe', () => {
			const win = makeFakeWindow();
			const id = registry.create({ browserWindow: win, sessionIds: ['a'], isMain: true });

			const unsubscribe = wireWindowRegistryBroadcast(registry);
			unsubscribe();
			registry.setSessionsForWindow(id, ['a', 'b']);

			expect(sendOf(win)).not.toHaveBeenCalled();
		});
	});

	describe('wireEmptySecondaryWindowAutoClose', () => {
		it('closes a secondary window once its last agent moves out', () => {
			const primaryWin = makeFakeWindow();
			const secondaryWin = makeFakeWindow();
			const primary = registry.create({
				browserWindow: primaryWin,
				sessionIds: [],
				isMain: true,
			});
			const secondary = registry.create({
				browserWindow: secondaryWin,
				sessionIds: ['agent-1'],
				isMain: false,
			});

			wireEmptySecondaryWindowAutoClose(registry);
			// Move the secondary's lone agent back to the primary: the secondary is now
			// empty and should be closed.
			registry.moveSession('agent-1', secondary, primary);

			expect(secondaryWin.close).toHaveBeenCalledTimes(1);
			// The primary is never auto-closed, even when it happens to be empty.
			expect(primaryWin.close).not.toHaveBeenCalled();
		});

		it('leaves a secondary that still owns agents open', () => {
			const secondaryWin = makeFakeWindow();
			registry.create({ browserWindow: makeFakeWindow(), sessionIds: [], isMain: true });
			const secondary = registry.create({
				browserWindow: secondaryWin,
				sessionIds: ['a', 'b'],
				isMain: false,
			});
			const other = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: [],
				isMain: false,
			});

			wireEmptySecondaryWindowAutoClose(registry);
			registry.moveSession('a', secondary, other);

			// 'b' still lives here, so the window stays open.
			expect(secondaryWin.close).not.toHaveBeenCalled();
		});

		it('skips a secondary window that is already destroyed', () => {
			const destroyedWin = makeFakeWindow({ isDestroyed: vi.fn(() => true) });
			const primary = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: [],
				isMain: true,
			});
			const secondary = registry.create({
				browserWindow: destroyedWin,
				sessionIds: ['agent-1'],
				isMain: false,
			});

			wireEmptySecondaryWindowAutoClose(registry);
			registry.moveSession('agent-1', secondary, primary);

			expect(destroyedWin.close).not.toHaveBeenCalled();
		});

		it('stops auto-closing after unsubscribe', () => {
			const secondaryWin = makeFakeWindow();
			const primary = registry.create({
				browserWindow: makeFakeWindow(),
				sessionIds: [],
				isMain: true,
			});
			const secondary = registry.create({
				browserWindow: secondaryWin,
				sessionIds: ['agent-1'],
				isMain: false,
			});

			const unsubscribe = wireEmptySecondaryWindowAutoClose(registry);
			unsubscribe();
			registry.moveSession('agent-1', secondary, primary);

			expect(secondaryWin.close).not.toHaveBeenCalled();
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
