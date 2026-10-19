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
	pickFocusWindowSpec,
	planTabWindowRestore,
	planWindowRestore,
	readExistingAgentIds,
	readExistingAgentTabs,
	registeredWindowToWindowState,
	saveAllWindowStates,
	saveWindowState,
	wireWindowStateSaveOnChange,
} from '../window-state-persistence';
import type { WindowRestoreSpec } from '../window-state-persistence';
import type { SessionsData } from '../stores/types';
import type {
	MultiWindowState,
	WindowState as PersistedWindowState,
} from '../../shared/window-types';

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

/** Build a persisted (shared) WindowState with sane defaults for restore tests. */
function makePersistedWindow(overrides: Partial<PersistedWindowState> = {}): PersistedWindowState {
	return {
		id: 'w',
		x: 0,
		y: 0,
		width: 1000,
		height: 700,
		isMaximized: false,
		isFullScreen: false,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
		...overrides,
	};
}

const AI_TAB = { type: 'ai' as const, id: 'tab-a' };
const FILE_TAB = { type: 'file' as const, id: 'tab-b' };
const TERMINAL_TAB = { type: 'terminal' as const, id: 'tab-c' };

/** A persisted tab window record. */
function makePersistedTabWindow(
	overrides: Partial<PersistedWindowState> = {}
): PersistedWindowState {
	return makePersistedWindow({
		id: 'tw',
		width: 900,
		height: 700,
		kind: 'tab',
		agentId: 'agent-1',
		tabRefs: [AI_TAB, FILE_TAB],
		activeTabRef: FILE_TAB,
		...overrides,
	});
}

/** A fake sessions store whose `get('sessions', [])` returns the given rows. */
function makeSessionsStore(sessions: unknown): Pick<Store<SessionsData>, 'get'> {
	return {
		get: vi.fn((_key: string, fallback?: unknown) =>
			sessions === undefined ? fallback : sessions
		),
	} as unknown as Pick<Store<SessionsData>, 'get'>;
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

		it('records the agent, tabs, and active tab of a tab window', () => {
			registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
			registry.create({
				windowId: 'tw',
				browserWindow: makeWindow({ bounds: { x: 30, y: 40, width: 900, height: 700 } }),
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB, FILE_TAB],
				activeTabRef: FILE_TAB,
			});

			expect(registeredWindowToWindowState(registry.get('tw')!)).toEqual({
				id: 'tw',
				x: 30,
				y: 40,
				width: 900,
				height: 700,
				isMaximized: false,
				isFullScreen: false,
				sessionIds: [],
				activeSessionId: null,
				leftPanelCollapsed: false,
				rightPanelCollapsed: false,
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB, FILE_TAB],
				activeTabRef: FILE_TAB,
			});
		});

		it('copies tab refs so the persisted snapshot does not alias the registry', () => {
			registry.create({ windowId: 'main', browserWindow: makeWindow(), isMain: true });
			registry.create({
				windowId: 'tw',
				browserWindow: makeWindow(),
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
			});
			const state = registeredWindowToWindowState(registry.get('tw')!);
			registry.addTabToTabWindow('tw', 'agent-1', FILE_TAB);
			expect(state.tabRefs).toEqual([AI_TAB]);
		});

		it('persists a user-assigned window name', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.setName('w1', 'Deploy Watch');
			expect(registeredWindowToWindowState(registry.get('w1')!).name).toBe('Deploy Watch');
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

		it('saves tab windows apart from the app windows (TW-10)', () => {
			registry.create({ windowId: 'primary', browserWindow: makeWindow(), isMain: true });
			registry.create({
				windowId: 'tw',
				browserWindow: makeWindow(),
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
			});

			const result = buildMultiWindowState(registry);

			expect(result.windows.map((w) => w.id)).toEqual(['primary']);
			expect(result.primaryWindowId).toBe('primary');
			expect(result.tabWindows).toEqual([
				expect.objectContaining({
					id: 'tw',
					kind: 'tab',
					agentId: 'agent-1',
					tabRefs: [AI_TAB],
					activeTabRef: AI_TAB,
				}),
			]);
		});

		it('skips a tab window whose last tab left, and a destroyed one', () => {
			registry.create({ windowId: 'primary', browserWindow: makeWindow(), isMain: true });
			registry.create({
				windowId: 'emptied',
				browserWindow: makeWindow(),
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
			});
			registry.removeTabFromTabWindow('emptied', AI_TAB);
			registry.create({
				windowId: 'dead',
				browserWindow: makeWindow({ destroyed: true }),
				kind: 'tab',
				agentId: 'agent-2',
				tabRefs: [FILE_TAB],
			});

			expect(buildMultiWindowState(registry).tabWindows).toEqual([]);
		});

		it('returns an empty layout with no live windows', () => {
			const result = buildMultiWindowState(registry);
			expect(result).toEqual({ windows: [], primaryWindowId: '', tabWindows: [] });
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

	describe('planWindowRestore', () => {
		it('returns no specs for undefined state (fall back to a single primary)', () => {
			expect(planWindowRestore(undefined, new Set())).toEqual([]);
		});

		it('returns no specs when the state tracks zero windows', () => {
			const state: MultiWindowState = { windows: [], primaryWindowId: '' };
			expect(planWindowRestore(state, new Set())).toEqual([]);
		});

		it('plans the primary first, then secondaries in saved order, carrying bounds', () => {
			const state: MultiWindowState = {
				primaryWindowId: 'primary',
				windows: [
					makePersistedWindow({ id: 'secondary-a', x: 10, y: 20, sessionIds: ['a'] }),
					makePersistedWindow({ id: 'primary', x: 0, y: 0, sessionIds: ['p'] }),
					makePersistedWindow({ id: 'secondary-b', x: 30, y: 40, sessionIds: ['b'] }),
				],
			};

			const specs = planWindowRestore(state, new Set(['a', 'b', 'p']));

			expect(specs.map((s) => s.isPrimary)).toEqual([true, false, false]);
			expect(specs.map((s) => s.bounds.id)).toEqual(['primary', 'secondary-a', 'secondary-b']);
			expect(specs.map((s) => s.sessionIds)).toEqual([['p'], ['a'], ['b']]);
			// Bounds ride through untouched so each window restores where it was.
			expect(specs[1].bounds).toMatchObject({ x: 10, y: 20 });
		});

		it('carries a saved window name through the restore spec bounds (id + name reconnect)', () => {
			const state: MultiWindowState = {
				primaryWindowId: 'primary',
				windows: [
					makePersistedWindow({ id: 'primary', sessionIds: ['p'] }),
					makePersistedWindow({ id: 'secondary', sessionIds: ['a'], name: 'Deploy Watch' }),
				],
			};

			const specs = planWindowRestore(state, new Set(['a', 'p']));

			const secondary = specs.find((s) => !s.isPrimary);
			// The window manager reads bounds.id + bounds.name to re-adopt the id and
			// reconnect the custom name on restore.
			expect(secondary?.bounds.id).toBe('secondary');
			expect(secondary?.bounds.name).toBe('Deploy Watch');
		});

		it('drops agents that no longer exist from each window', () => {
			const state: MultiWindowState = {
				primaryWindowId: 'primary',
				windows: [
					makePersistedWindow({ id: 'primary', sessionIds: ['alive', 'deleted'] }),
					makePersistedWindow({ id: 'secondary', sessionIds: ['gone', 'kept'] }),
				],
			};

			const specs = planWindowRestore(state, new Set(['alive', 'kept']));

			expect(specs[0].sessionIds).toEqual(['alive']);
			expect(specs[1].sessionIds).toEqual(['kept']);
		});

		it('falls back to the first window as primary when primaryWindowId is dangling', () => {
			const state: MultiWindowState = {
				primaryWindowId: 'missing',
				windows: [
					makePersistedWindow({ id: 'first', sessionIds: ['x'] }),
					makePersistedWindow({ id: 'second', sessionIds: ['y'] }),
				],
			};

			const specs = planWindowRestore(state, new Set(['x', 'y']));

			expect(specs[0]).toMatchObject({ isPrimary: true, bounds: { id: 'first' } });
			expect(specs[1]).toMatchObject({ isPrimary: false, bounds: { id: 'second' } });
		});
	});

	describe('wireWindowStateSaveOnChange', () => {
		function setupPrimaryAndTabWindow() {
			registry.create({ windowId: 'primary', browserWindow: makeWindow(), isMain: true });
			registry.create({
				windowId: 'tw',
				browserWindow: makeWindow(),
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
			});
		}

		it('saves on a rename and on a panel toggle', () => {
			const store = makeStore();
			registry.create({ windowId: 'primary', browserWindow: makeWindow(), isMain: true });
			wireWindowStateSaveOnChange(store, registry);

			registry.setName('primary', 'Main');
			registry.setPanelState('primary', { leftPanelCollapsed: true, rightPanelCollapsed: false });

			expect(store.set).toHaveBeenCalledTimes(2);
			expect(store.set.mock.calls[1][1].windows[0]).toMatchObject({
				name: 'Main',
				leftPanelCollapsed: true,
			});
		});

		it('saves when a tab pops out into or docks from a tab window (TW-10)', () => {
			const store = makeStore();
			setupPrimaryAndTabWindow();
			wireWindowStateSaveOnChange(store, registry);

			registry.addTabToTabWindow('tw', 'agent-1', FILE_TAB);
			expect(store.set).toHaveBeenCalledTimes(1);
			expect(store.set.mock.calls[0][1].tabWindows[0].tabRefs).toEqual([AI_TAB, FILE_TAB]);

			registry.removeTabFromTabWindow('tw', AI_TAB);
			registry.removeTabFromTabWindow('tw', FILE_TAB);
			// The last dock saves a layout without the emptied tab window.
			expect(store.set.mock.calls.at(-1)?.[1].tabWindows).toEqual([]);
		});

		it('drops a destroyed tab window from the layout when its tabs dock after destroy', () => {
			const store = makeStore();
			const tabBrowserWindow = makeWindow();
			registry.create({ windowId: 'primary', browserWindow: makeWindow(), isMain: true });
			registry.create({
				windowId: 'tw',
				browserWindow: tabBrowserWindow,
				kind: 'tab',
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
			});
			wireWindowStateSaveOnChange(store, registry);
			vi.mocked(tabBrowserWindow.isDestroyed).mockReturnValue(true);

			registry.removeTabFromTabWindow('tw', AI_TAB);

			expect(store.set).toHaveBeenCalledTimes(1);
			expect(store.set.mock.calls[0][1].tabWindows).toEqual([]);
		});

		it('ignores the other changes and stops after unsubscribe', () => {
			const store = makeStore();
			setupPrimaryAndTabWindow();
			const unsubscribe = wireWindowStateSaveOnChange(store, registry);

			registry.create({ windowId: 'secondary', browserWindow: makeWindow(), isMain: false });
			expect(store.set).not.toHaveBeenCalled();

			unsubscribe();
			registry.addTabToTabWindow('tw', 'agent-1', FILE_TAB);
			expect(store.set).not.toHaveBeenCalled();
		});
	});

	describe('pickFocusWindowSpec', () => {
		const spec = (isPrimary: boolean, sessionIds: string[]): WindowRestoreSpec => ({
			isPrimary,
			sessionIds,
			bounds: makePersistedWindow({ id: isPrimary ? 'primary' : sessionIds.join('-'), sessionIds }),
		});

		it('returns undefined for an empty spec list', () => {
			expect(pickFocusWindowSpec([], 'a')).toBeUndefined();
		});

		it('focuses the primary when there is no active agent', () => {
			const specs = [spec(true, ['p']), spec(false, ['a'])];
			expect(pickFocusWindowSpec(specs, undefined)).toBe(specs[0]);
			expect(pickFocusWindowSpec(specs, null)).toBe(specs[0]);
		});

		it('focuses the secondary window that owns the active agent', () => {
			const specs = [spec(true, ['p']), spec(false, ['a']), spec(false, ['b'])];
			expect(pickFocusWindowSpec(specs, 'b')).toBe(specs[2]);
		});

		it('focuses the primary (catch-all owner) when no secondary owns the active agent', () => {
			// The active agent is not in any secondary's owned set, so it lives in the
			// primary's catch-all - focus the primary. This is the stacked-restore case
			// that made startup open onto an empty secondary window.
			const specs = [spec(true, []), spec(false, ['other'])];
			expect(pickFocusWindowSpec(specs, 'active')).toBe(specs[0]);
		});
	});

	describe('readExistingAgentIds', () => {
		it('returns the id of every existing agent in order', () => {
			const store = makeSessionsStore([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

			expect(readExistingAgentIds(store)).toEqual(['a', 'b', 'c']);
		});

		it('returns an empty array when there are no agents', () => {
			expect(readExistingAgentIds(makeSessionsStore([]))).toEqual([]);
		});

		it('skips non-string ids defensively in a corrupt store', () => {
			const store = makeSessionsStore([{ id: 'a' }, { id: 42 }, {}, null, { id: 'b' }]);

			expect(readExistingAgentIds(store)).toEqual(['a', 'b']);
		});

		it('returns an empty array (never throws) when get ignores the fallback', () => {
			// A stub/corrupt store whose `get` returns undefined regardless of the
			// fallback. This runs at startup outside any try/catch, so it must not
			// throw "sessions is not iterable".
			const store = {
				get: vi.fn(() => undefined),
			} as unknown as Pick<Store<SessionsData>, 'get'>;

			expect(() => readExistingAgentIds(store)).not.toThrow();
			expect(readExistingAgentIds(store)).toEqual([]);
		});
	});
	describe('readExistingAgentTabs', () => {
		it('keys every stored tab of every agent by type and id', () => {
			const store = makeSessionsStore([
				{
					id: 'agent-1',
					aiTabs: [{ id: 'tab-a' }],
					filePreviewTabs: [{ id: 'tab-b' }],
					terminalTabs: [{ id: 'tab-c' }],
					browserTabs: [{ id: 'tab-d' }],
				},
				{ id: 'agent-2' },
			]);

			const tabs = readExistingAgentTabs(store);

			expect([...tabs.keys()]).toEqual(['agent-1', 'agent-2']);
			expect([...tabs.get('agent-1')!]).toEqual([
				'ai:tab-a',
				'file:tab-b',
				'terminal:tab-c',
				'browser:tab-d',
			]);
			expect(tabs.get('agent-2')!.size).toBe(0);
		});

		it('leaves out hidden consult AI tabs (TW-14)', () => {
			const store = makeSessionsStore([
				{ id: 'agent-1', aiTabs: [{ id: 'shown' }, { id: 'consult', hidden: true }] },
			]);

			expect([...readExistingAgentTabs(store).get('agent-1')!]).toEqual(['ai:shown']);
		});

		it('skips malformed rows and never throws on a corrupt store', () => {
			const store = makeSessionsStore([
				null,
				{ id: 42 },
				{ id: 'agent-1', aiTabs: 'nope', terminalTabs: [null, { id: 7 }, { id: 'tab-c' }] },
			]);

			const tabs = readExistingAgentTabs(store);
			expect([...tabs.keys()]).toEqual(['agent-1']);
			expect([...tabs.get('agent-1')!]).toEqual(['terminal:tab-c']);

			const broken = { get: vi.fn(() => undefined) } as unknown as Pick<Store<SessionsData>, 'get'>;
			expect(() => readExistingAgentTabs(broken)).not.toThrow();
			expect(readExistingAgentTabs(broken).size).toBe(0);
		});
	});

	describe('planTabWindowRestore', () => {
		const existing = (entries: Record<string, string[]>) =>
			new Map(Object.entries(entries).map(([agentId, keys]) => [agentId, new Set(keys)]));

		it('returns nothing without saved tab windows (state from before Tab Windows)', () => {
			const state: MultiWindowState = {
				windows: [makePersistedWindow({ id: 'primary' })],
				primaryWindowId: 'primary',
			};
			expect(planTabWindowRestore(undefined, existing({}))).toEqual([]);
			expect(planTabWindowRestore(state, existing({ 'agent-1': ['ai:tab-a'] }))).toEqual([]);
		});

		it('restores the agent, tabs, active tab, and saved bounds', () => {
			const record = makePersistedTabWindow({ x: 2000, y: 100 });
			const state: MultiWindowState = {
				windows: [makePersistedWindow({ id: 'primary' })],
				primaryWindowId: 'primary',
				tabWindows: [record],
			};

			const specs = planTabWindowRestore(
				state,
				existing({ 'agent-1': ['ai:tab-a', 'file:tab-b'] })
			);

			expect(specs).toEqual([
				{
					agentId: 'agent-1',
					tabRefs: [AI_TAB, FILE_TAB],
					activeTabRef: FILE_TAB,
					bounds: record,
				},
			]);
			// Bounds pass through untouched: the window manager clamps them onto a
			// present display when it builds the window.
			expect(specs[0].bounds).toMatchObject({ id: 'tw', x: 2000, y: 100 });
		});

		it('drops the record of an agent that no longer exists', () => {
			const state: MultiWindowState = {
				windows: [],
				primaryWindowId: '',
				tabWindows: [
					makePersistedTabWindow({ id: 'gone', agentId: 'deleted-agent' }),
					makePersistedTabWindow({ id: 'kept', agentId: 'agent-1' }),
				],
			};

			const specs = planTabWindowRestore(
				state,
				existing({ 'agent-1': ['ai:tab-a', 'file:tab-b'] })
			);

			expect(specs.map((spec) => spec.bounds.id)).toEqual(['kept']);
		});

		it('drops refs of tabs that are gone, and the active ref with them', () => {
			const state: MultiWindowState = {
				windows: [],
				primaryWindowId: '',
				tabWindows: [makePersistedTabWindow({ tabRefs: [AI_TAB, FILE_TAB, TERMINAL_TAB] })],
			};

			const [spec] = planTabWindowRestore(
				state,
				existing({ 'agent-1': ['ai:tab-a', 'terminal:tab-c'] })
			);

			expect(spec.tabRefs).toEqual([AI_TAB, TERMINAL_TAB]);
			expect(spec.activeTabRef).toBeNull();
		});

		it('drops a record left with no tab', () => {
			const state: MultiWindowState = {
				windows: [],
				primaryWindowId: '',
				tabWindows: [makePersistedTabWindow()],
			};

			expect(planTabWindowRestore(state, existing({ 'agent-1': ['ai:other'] }))).toEqual([]);
		});

		it('keeps one tab window per agent and drops malformed and duplicate refs (TW-4)', () => {
			const state: MultiWindowState = {
				windows: [],
				primaryWindowId: '',
				tabWindows: [
					makePersistedTabWindow({
						id: 'first',
						tabRefs: [
							AI_TAB,
							{ ...AI_TAB },
							{ type: 'group', id: 'g1' } as never,
							{ type: 'ai', id: '' },
						],
						activeTabRef: { type: 'group', id: 'g1' } as never,
					}),
					makePersistedTabWindow({ id: 'second', tabRefs: [FILE_TAB] }),
					{ ...makePersistedTabWindow({ id: 'no-agent' }), agentId: undefined },
				],
			};

			const specs = planTabWindowRestore(
				state,
				existing({ 'agent-1': ['ai:tab-a', 'file:tab-b'] })
			);

			expect(specs).toHaveLength(1);
			expect(specs[0]).toMatchObject({
				agentId: 'agent-1',
				tabRefs: [AI_TAB],
				activeTabRef: null,
				bounds: { id: 'first' },
			});
		});
	});
});
