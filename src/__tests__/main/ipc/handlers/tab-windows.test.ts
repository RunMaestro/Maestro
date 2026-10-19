/**
 * Tests for the Tab Windows IPC handlers and the service behind them.
 *
 * Tests cover:
 * - Handler and relay listener registration
 * - tabWindows:popOut: a new window, reuse of the agent's window (TW-4),
 *   background, the hidden consult tab refusal (TW-14), bad arguments
 * - tabWindows:dock, tabWindows:focus, tabWindows:list, tabWindows:getState
 * - The relay: patches only from the agent's CURRENT owner, intents only from
 *   the agent's own tab window (TW-5), and both re-addressed after a Move to
 *   Window (D7)
 *
 * The real WindowRegistry is used with cast-mock BrowserWindows (the
 * windows.test.ts convention). The window manager is a fake whose
 * createTabWindow registers the window, as the real one does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		on: vi.fn(),
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

const summonAppWindow = vi.fn();
vi.mock('../../../../main/global-hotkey-manager', () => ({
	summonAppWindow: (...args: unknown[]) => summonAppWindow(...args),
}));

const reroutePermissionRequests = vi.fn();
vi.mock('../../../../main/permission-relay', () => ({
	reroutePermissionRequests: () => reroutePermissionRequests(),
}));

import {
	registerTabWindowsHandlers,
	wireTabWindowPermissionRerouting,
} from '../../../../main/ipc/handlers/tab-windows';
import {
	findTabWindowHoldingAiTab,
	isStoredAiTabHidden,
} from '../../../../main/tab-window-service';
import { WindowRegistry } from '../../../../main/window-registry';
import { terminalHandoff } from '../../../../main/terminal-handoff';
import type {
	TabWindowIntent,
	TabWindowSessionPatch,
	TabWindowTabRef,
} from '../../../../shared/tabWindowTypes';

function makeFakeWindow(): BrowserWindow {
	return {
		getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
		isDestroyed: vi.fn(() => false),
		isMinimized: vi.fn(() => false),
		restore: vi.fn(),
		focus: vi.fn(),
		close: vi.fn(),
		webContents: {
			send: vi.fn(),
			isDestroyed: vi.fn(() => false),
		},
	} as unknown as BrowserWindow;
}

function sendOf(win: BrowserWindow): ReturnType<typeof vi.fn> {
	return (win as unknown as { webContents: { send: ReturnType<typeof vi.fn> } }).webContents.send;
}

/** A fake IPC event whose sender resolves to `browserWindow`. */
function eventFrom(browserWindow: BrowserWindow | null) {
	vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(browserWindow as never);
	return { sender: { id: 1 } } as never;
}

const AI_TAB: TabWindowTabRef = { type: 'ai', id: 'tab-1' };
const FILE_TAB: TabWindowTabRef = { type: 'file', id: 'file-1' };

describe('Tab Windows IPC Handlers', () => {
	let registry: WindowRegistry;
	let handlers: Map<string, Function>;
	let listeners: Map<string, Function>;
	let createTabWindow: ReturnType<typeof vi.fn>;
	let storedSessions: unknown[];
	let primaryWin: BrowserWindow;
	let primaryId: string;

	function register(opts: { withRegistry?: boolean; withManager?: boolean } = {}) {
		const { withRegistry = true, withManager = true } = opts;
		registerTabWindowsHandlers({
			getWindowRegistry: () => (withRegistry ? registry : null),
			getWindowManager: () => (withManager ? ({ createTabWindow } as never) : null),
			sessionsStore: { get: vi.fn(() => storedSessions) } as never,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new WindowRegistry();
		handlers = new Map();
		listeners = new Map();
		storedSessions = [];
		primaryWin = makeFakeWindow();
		primaryId = registry.create({
			browserWindow: primaryWin,
			sessionIds: ['agent-1'],
			isMain: true,
		});

		// The real factory registers the window it builds; so does this fake.
		createTabWindow = vi.fn(
			(options: { agentId: string; tabRefs: TabWindowTabRef[]; background?: boolean }) => {
				const browserWindow = makeFakeWindow();
				registry.create({
					browserWindow,
					kind: 'tab',
					agentId: options.agentId,
					tabRefs: options.tabRefs,
				});
				return browserWindow;
			}
		);

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});
		vi.mocked(ipcMain.on).mockImplementation(((channel: string, listener: Function) => {
			listeners.set(channel, listener);
			return ipcMain;
		}) as never);

		register();
	});

	const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

	it('registers the request handlers and the two relay listeners', () => {
		for (const channel of [
			'tabWindows:popOut',
			'tabWindows:dock',
			'tabWindows:focus',
			'tabWindows:reorder',
			'tabWindows:list',
			'tabWindows:getState',
		]) {
			expect(handlers.has(channel)).toBe(true);
		}
		expect(listeners.has('tabWindow:sessionPatch')).toBe(true);
		expect(listeners.has('tabWindow:intent')).toBe(true);
		// The terminal handoff (D5).
		for (const channel of [
			'tabWindow:terminalRelease',
			'tabWindow:terminalCommit',
			'tabWindow:terminalClaim',
		]) {
			expect(listeners.has(channel)).toBe(true);
		}
	});

	describe('terminal handoff (D5)', () => {
		const TERMINAL_TAB: TabWindowTabRef = { type: 'terminal', id: 'term-1' };
		const PTY = 'agent-1-terminal-term-1';

		beforeEach(() => terminalHandoff.clear());
		afterEach(() => terminalHandoff.clear());

		it('announces the move of a terminal view on pop-out, into a new or an existing window', async () => {
			await invoke('tabWindows:popOut', 'agent-1', TERMINAL_TAB);
			expect(terminalHandoff.has(PTY)).toBe(true);

			terminalHandoff.clear();
			await invoke('tabWindows:popOut', 'agent-1', { type: 'terminal', id: 'term-2' });
			expect(terminalHandoff.has('agent-1-terminal-term-2')).toBe(true);
		});

		it('announces nothing for another tab type, or a terminal already in the window', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			expect(terminalHandoff.has('agent-1-terminal-tab-1')).toBe(false);

			await invoke('tabWindows:popOut', 'agent-1', TERMINAL_TAB);
			terminalHandoff.clear();
			await invoke('tabWindows:popOut', 'agent-1', TERMINAL_TAB);
			expect(terminalHandoff.has(PTY)).toBe(false);
		});

		it('announces the move back on dock, so the owner view waits for the replay', async () => {
			await invoke('tabWindows:popOut', 'agent-1', TERMINAL_TAB);
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			terminalHandoff.clear();

			await invoke('tabWindows:dock', 'agent-1', TERMINAL_TAB);

			const reply = vi.fn();
			terminalHandoff.claim(PTY, reply);
			expect(reply).not.toHaveBeenCalled();
			terminalHandoff.commit(PTY, 'tab window scrollback');
			expect(reply).toHaveBeenCalledWith('tab window scrollback');
		});
	});

	describe('tabWindows:popOut', () => {
		it('opens the agent tab window with the tab when it has none', async () => {
			const result = await invoke('tabWindows:popOut', 'agent-1', AI_TAB);

			expect(createTabWindow).toHaveBeenCalledWith({
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
				background: false,
			});
			const entry = registry.getTabWindowForAgent('agent-1')!;
			expect(result).toEqual({ poppedOut: true, windowId: entry.id, created: true });
		});

		it('passes background to the factory', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB, { background: true });
			expect(createTabWindow).toHaveBeenCalledWith(expect.objectContaining({ background: true }));
		});

		it('adds a second tab of the same agent to its existing window and raises it (TW-4)', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			const entry = registry.getTabWindowForAgent('agent-1')!;

			const result = await invoke('tabWindows:popOut', 'agent-1', FILE_TAB);

			expect(createTabWindow).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ poppedOut: true, windowId: entry.id, created: false });
			expect(entry.tabRefs).toEqual([AI_TAB, FILE_TAB]);
			expect(entry.activeTabRef).toEqual(FILE_TAB);
			expect(summonAppWindow).toHaveBeenCalledWith(entry.browserWindow);
		});

		it('in the background, joins the strip without showing the tab or raising the window', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			const entry = registry.getTabWindowForAgent('agent-1')!;

			await invoke('tabWindows:popOut', 'agent-1', FILE_TAB, { background: true });

			expect(entry.tabRefs).toEqual([AI_TAB, FILE_TAB]);
			expect(entry.activeTabRef).toEqual(AI_TAB);
			expect(summonAppWindow).not.toHaveBeenCalled();
		});

		it('gives each agent its own window (TW-5)', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			await invoke('tabWindows:popOut', 'agent-2', { type: 'ai', id: 'other' });

			expect(createTabWindow).toHaveBeenCalledTimes(2);
			expect(registry.getTabWindowForAgent('agent-1')).not.toBe(
				registry.getTabWindowForAgent('agent-2')
			);
		});

		it('refuses a hidden consult tab (TW-14)', async () => {
			storedSessions = [{ id: 'agent-1', aiTabs: [{ id: 'tab-1', hidden: true }] }];

			const result = await invoke('tabWindows:popOut', 'agent-1', AI_TAB);

			expect(result).toEqual({
				poppedOut: false,
				error: 'A hidden consult tab cannot be popped out',
			});
			expect(createTabWindow).not.toHaveBeenCalled();
		});

		it('refuses a missing agent id or a malformed or group tab ref', async () => {
			expect((await invoke('tabWindows:popOut', '', AI_TAB)).poppedOut).toBe(false);
			expect((await invoke('tabWindows:popOut', 'agent-1', { type: 'ai' })).poppedOut).toBe(false);
			expect(
				(await invoke('tabWindows:popOut', 'agent-1', { type: 'group', id: 'g1' })).poppedOut
			).toBe(false);
			expect(createTabWindow).not.toHaveBeenCalled();
		});

		it('reports an untracked window instead of inventing an id', async () => {
			createTabWindow.mockReturnValue(makeFakeWindow());
			const result = await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			expect(result.poppedOut).toBe(false);
		});

		it('throws when the window manager is not wired', async () => {
			register({ withManager: false });
			await expect(invoke('tabWindows:popOut', 'agent-1', AI_TAB)).rejects.toThrow(
				'Window manager not initialized'
			);
		});
	});

	describe('tabWindows:dock', () => {
		it('takes the tab out of the agent tab window', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			await invoke('tabWindows:popOut', 'agent-1', FILE_TAB);
			const entry = registry.getTabWindowForAgent('agent-1')!;

			const result = await invoke('tabWindows:dock', 'agent-1', AI_TAB);

			expect(result).toEqual({ docked: true, windowId: entry.id });
			expect(entry.tabRefs).toEqual([FILE_TAB]);
		});

		it('refuses an agent with no tab window, or a tab it does not hold', async () => {
			expect(await invoke('tabWindows:dock', 'agent-1', AI_TAB)).toEqual({
				docked: false,
				error: 'The agent has no tab window',
			});
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			expect(await invoke('tabWindows:dock', 'agent-1', FILE_TAB)).toEqual({
				docked: false,
				error: "The tab is not in the agent's tab window",
			});
		});
	});

	describe('tabWindows:focus', () => {
		it('shows the tab in the agent tab window and raises that window', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			await invoke('tabWindows:popOut', 'agent-1', FILE_TAB, { background: true });
			const entry = registry.getTabWindowForAgent('agent-1')!;
			summonAppWindow.mockClear();

			const result = await invoke('tabWindows:focus', 'agent-1', FILE_TAB);

			expect(result).toEqual({ focused: true, windowId: entry.id });
			expect(entry.activeTabRef).toEqual(FILE_TAB);
			expect(summonAppWindow).toHaveBeenCalledWith(entry.browserWindow);
		});

		it('refuses an agent with no tab window, a tab it does not hold, or bad arguments', async () => {
			expect(await invoke('tabWindows:focus', 'agent-1', AI_TAB)).toEqual({
				focused: false,
				error: 'The agent has no tab window',
			});
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			summonAppWindow.mockClear();
			expect(await invoke('tabWindows:focus', 'agent-1', FILE_TAB)).toEqual({
				focused: false,
				error: "The tab is not in the agent's tab window",
			});
			expect((await invoke('tabWindows:focus', '', AI_TAB)).focused).toBe(false);
			expect(
				(await invoke('tabWindows:focus', 'agent-1', { type: 'group', id: 'g1' })).focused
			).toBe(false);
			expect(summonAppWindow).not.toHaveBeenCalled();
		});
	});

	describe('tabWindows:reorder', () => {
		it('sets the tab window strip order, which the owner runs for the reorderTabs intent', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			await invoke('tabWindows:popOut', 'agent-1', FILE_TAB);
			const entry = registry.getTabWindowForAgent('agent-1')!;

			expect(await invoke('tabWindows:reorder', 'agent-1', [FILE_TAB, AI_TAB])).toEqual({
				reordered: true,
				windowId: entry.id,
			});
			expect(entry.tabRefs).toEqual([FILE_TAB, AI_TAB]);
		});

		it('refuses an agent with no tab window, an order that is not its tabs, or bad arguments', async () => {
			expect(await invoke('tabWindows:reorder', 'agent-1', [AI_TAB])).toEqual({
				reordered: false,
				error: 'The agent has no tab window',
			});
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			expect(await invoke('tabWindows:reorder', 'agent-1', [FILE_TAB])).toEqual({
				reordered: false,
				error: "The order does not name exactly the tab window's tabs",
			});
			expect((await invoke('tabWindows:reorder', '', [AI_TAB])).reordered).toBe(false);
			expect((await invoke('tabWindows:reorder', 'agent-1', 'nope')).reordered).toBe(false);
			expect(
				(await invoke('tabWindows:reorder', 'agent-1', [{ type: 'group', id: 'g' }])).reordered
			).toBe(false);
		});
	});

	describe('tabWindows:list', () => {
		it('lists every tab window and no app window', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			await invoke('tabWindows:popOut', 'agent-2', FILE_TAB);

			const list = await invoke('tabWindows:list');

			expect(list).toEqual([
				{
					windowId: registry.getTabWindowForAgent('agent-1')!.id,
					agentId: 'agent-1',
					tabRefs: [AI_TAB],
					activeTabRef: AI_TAB,
				},
				{
					windowId: registry.getTabWindowForAgent('agent-2')!.id,
					agentId: 'agent-2',
					tabRefs: [FILE_TAB],
					activeTabRef: FILE_TAB,
				},
			]);
		});
	});

	describe('tabWindows:getState', () => {
		it('answers a tab window with its own record', async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			const entry = registry.getTabWindowForAgent('agent-1')!;

			const state = handlers.get('tabWindows:getState')!(eventFrom(entry.browserWindow));

			expect(state).toEqual({
				windowId: entry.id,
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
				activeTabRef: AI_TAB,
			});
		});

		it('answers null for an app window or an unknown caller', () => {
			expect(handlers.get('tabWindows:getState')!(eventFrom(primaryWin))).toBeNull();
			expect(handlers.get('tabWindows:getState')!(eventFrom(null))).toBeNull();
		});
	});

	describe('relay', () => {
		const patch: TabWindowSessionPatch = {
			form: 'snapshot',
			agentId: 'agent-1',
			seq: 0,
			tabRefs: [AI_TAB],
			session: { id: 'agent-1' },
		};
		const intent = {
			kind: 'renameTab',
			agentId: 'agent-1',
			tabRef: AI_TAB,
			name: 'Renamed',
		} as TabWindowIntent;
		const relayPatch = (from: BrowserWindow | null, value: unknown) =>
			listeners.get('tabWindow:sessionPatch')!(eventFrom(from), value);
		const relayIntent = (from: BrowserWindow | null, value: unknown) =>
			listeners.get('tabWindow:intent')!(eventFrom(from), value);

		let tabWin: BrowserWindow;
		let secondaryWin: BrowserWindow;
		let secondaryId: string;

		beforeEach(async () => {
			await invoke('tabWindows:popOut', 'agent-1', AI_TAB);
			tabWin = registry.getTabWindowForAgent('agent-1')!.browserWindow;
			secondaryWin = makeFakeWindow();
			secondaryId = registry.create({ browserWindow: secondaryWin, sessionIds: [] });
		});

		it('forwards a patch from the owner to the agent tab window', () => {
			relayPatch(primaryWin, patch);
			expect(sendOf(tabWin)).toHaveBeenCalledWith('tabWindow:sessionPatch', patch);
		});

		it('drops a patch from a window that does not own the agent (D1)', () => {
			relayPatch(secondaryWin, patch);
			expect(sendOf(tabWin)).not.toHaveBeenCalled();
		});

		it('drops a malformed patch, or one for an agent with no tab window', () => {
			relayPatch(primaryWin, { form: 'delta', agentId: 'agent-1' });
			relayPatch(primaryWin, { ...patch, agentId: 'agent-2' });
			expect(sendOf(tabWin)).not.toHaveBeenCalled();
		});

		it('forwards an intent from the agent tab window to the owner', () => {
			relayIntent(tabWin, intent);
			expect(sendOf(primaryWin)).toHaveBeenCalledWith('tabWindow:intent', intent);
		});

		it('drops an intent a tab window sends for another agent (TW-5)', async () => {
			await invoke('tabWindows:popOut', 'agent-2', FILE_TAB);
			const otherTabWin = registry.getTabWindowForAgent('agent-2')!.browserWindow;

			relayIntent(otherTabWin, intent);

			expect(sendOf(primaryWin)).not.toHaveBeenCalled();
		});

		it('drops an intent from an app window or with an unknown kind', () => {
			relayIntent(primaryWin, intent);
			relayIntent(tabWin, { ...intent, kind: 'deleteEverything' });
			expect(sendOf(primaryWin)).not.toHaveBeenCalled();
		});

		it('re-addresses both directions after a Move to Window (D7)', () => {
			registry.moveSession('agent-1', primaryId, secondaryId);

			relayIntent(tabWin, intent);
			expect(sendOf(secondaryWin)).toHaveBeenCalledWith('tabWindow:intent', intent);
			expect(sendOf(primaryWin)).not.toHaveBeenCalled();

			// The old owner is now refused; the new one is heard.
			relayPatch(primaryWin, patch);
			expect(sendOf(tabWin)).not.toHaveBeenCalled();
			relayPatch(secondaryWin, patch);
			expect(sendOf(tabWin)).toHaveBeenCalledWith('tabWindow:sessionPatch', patch);
		});

		it('is a no-op while the registry is not wired', () => {
			listeners.clear();
			register({ withRegistry: false });
			expect(() => relayPatch(primaryWin, patch)).not.toThrow();
			expect(() => relayIntent(tabWin, intent)).not.toThrow();
		});
	});
});

describe('isStoredAiTabHidden', () => {
	const store = (sessions: unknown) => ({ get: vi.fn(() => sessions) }) as never;

	it('is true only for a stored AI tab flagged hidden', () => {
		const sessions = [
			{ id: 'a', aiTabs: [{ id: 't1', hidden: true }, { id: 't2' }] },
			{ id: 'b', aiTabs: [{ id: 't1' }] },
		];
		expect(isStoredAiTabHidden(store(sessions), 'a', { type: 'ai', id: 't1' })).toBe(true);
		expect(isStoredAiTabHidden(store(sessions), 'a', { type: 'ai', id: 't2' })).toBe(false);
		expect(isStoredAiTabHidden(store(sessions), 'b', { type: 'ai', id: 't1' })).toBe(false);
	});

	it('is false for a non-AI tab, an unknown agent or tab, or a corrupt store', () => {
		const sessions = [{ id: 'a', aiTabs: [{ id: 't1', hidden: true }] }];
		expect(isStoredAiTabHidden(store(sessions), 'a', { type: 'file', id: 't1' })).toBe(false);
		expect(isStoredAiTabHidden(store(sessions), 'ghost', { type: 'ai', id: 't1' })).toBe(false);
		expect(isStoredAiTabHidden(store(sessions), 'a', { type: 'ai', id: 'new' })).toBe(false);
		expect(isStoredAiTabHidden(store(null), 'a', { type: 'ai', id: 't1' })).toBe(false);
		expect(isStoredAiTabHidden(store([{ id: 'a' }]), 'a', { type: 'ai', id: 't1' })).toBe(false);
	});
});

describe('findTabWindowHoldingAiTab (permission prompt routing)', () => {
	it('finds the live tab window that holds the AI tab', () => {
		const registry = new WindowRegistry();
		const tabWin = makeFakeWindow();
		registry.create({ kind: 'tab', browserWindow: tabWin, agentId: 'agent-1', tabRefs: [AI_TAB] });

		expect(findTabWindowHoldingAiTab(registry, 'tab-1')).toBe(tabWin);
		expect(findTabWindowHoldingAiTab(registry, 'tab-1', 'agent-1-ai-tab-1')).toBe(tabWin);
	});

	it('finds nothing for a tab that is not popped, a file tab, or no tab id', () => {
		const registry = new WindowRegistry();
		registry.create({
			kind: 'tab',
			browserWindow: makeFakeWindow(),
			agentId: 'agent-1',
			tabRefs: [FILE_TAB],
		});

		expect(findTabWindowHoldingAiTab(registry, 'tab-1')).toBeNull();
		expect(findTabWindowHoldingAiTab(registry, 'file-1')).toBeNull();
		expect(findTabWindowHoldingAiTab(registry, undefined)).toBeNull();
	});

	it("refuses a spawn whose session id is another agent's", () => {
		const registry = new WindowRegistry();
		registry.create({
			kind: 'tab',
			browserWindow: makeFakeWindow(),
			agentId: 'agent-1',
			tabRefs: [AI_TAB],
		});

		expect(findTabWindowHoldingAiTab(registry, 'tab-1', 'agent-2-ai-tab-1')).toBeNull();
	});

	it('finds nothing when the tab window is gone', () => {
		const registry = new WindowRegistry();
		const gone = makeFakeWindow();
		vi.mocked(gone.isDestroyed).mockReturnValue(true);
		registry.create({ kind: 'tab', browserWindow: gone, agentId: 'agent-1', tabRefs: [AI_TAB] });

		expect(findTabWindowHoldingAiTab(registry, 'tab-1')).toBeNull();
	});
});

describe('wireTabWindowPermissionRerouting', () => {
	it('re-routes waiting permission prompts on every tab window change, and only then', () => {
		reroutePermissionRequests.mockClear();
		const registry = new WindowRegistry();
		const off = wireTabWindowPermissionRerouting(registry);
		const id = registry.create({
			kind: 'tab',
			browserWindow: makeFakeWindow(),
			agentId: 'agent-1',
			tabRefs: [AI_TAB, FILE_TAB],
		});
		// A new tab window with tabs is a tab window change: a prompt already
		// waiting for the popped tab moves to it.
		expect(reroutePermissionRequests).toHaveBeenCalledTimes(1);

		registry.create({ windowId: 'app', browserWindow: makeFakeWindow() });
		expect(reroutePermissionRequests).toHaveBeenCalledTimes(1);

		registry.removeTabFromTabWindow(id, AI_TAB);
		expect(reroutePermissionRequests).toHaveBeenCalledTimes(2);

		off();
		registry.removeTabFromTabWindow(id, FILE_TAB);
		expect(reroutePermissionRequests).toHaveBeenCalledTimes(2);
	});
});
