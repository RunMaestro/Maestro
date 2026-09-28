/**
 * Tests for the native application menu bridge.
 *
 * The menu is display-only: clicking an item sends its shortcut id to the
 * renderer, which replays it as a synthetic keydown so menu and keyboard share
 * one dispatch path. Two things have to hold for that to work:
 *
 * 1. Every shortcut behind a menu item must survive the replay - the event
 *    buildEventFromKeys produces has to match the same shortcut isShortcut
 *    would have matched from a real press.
 * 2. The bridge must publish the user's *merged* bindings, so a remap shows up
 *    in the menu instead of the bundled default.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcutHelpers } from '../../../../renderer/hooks/keyboard/useKeyboardShortcutHelpers';
import { useAppMenuBridge } from '../../../../renderer/hooks/keyboard/useAppMenuBridge';
import { buildEventFromKeys } from '../../../../renderer/utils/shortcutRecorder';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../../renderer/constants/shortcuts';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

/**
 * Shortcut ids referenced by the File / View / app menus in
 * src/main/app-menu.ts. Kept here so a rename on either side fails loudly
 * instead of silently rendering a dead menu item.
 */
const MENU_SHORTCUT_IDS = [
	'settings',
	'agentSettings',
	'help',
	'newInstance',
	'openWizard',
	'newGroupChat',
	'newTab',
	'newFileTab',
	'newBrowserTab',
	'fuzzyFileSearch',
	'renameTab',
	'closeTab',
	'closeOtherTabs',
	'closeAllTabs',
	'reopenClosedTab',
	'killInstance',
	'toggleSidebar',
	'toggleRightPanel',
	'toggleMode',
	'jumpToTerminal',
	'clearTerminal',
	'goToFiles',
	'goToHistory',
	'goToAutoRun',
	'prevTab',
	'nextTab',
	'cyclePrev',
	'cycleNext',
	'quickAction',
	'agentSwitcher',
	'usageDashboard',
	'systemLogs',
	'processMonitor',
	'fontSizeIncrease',
	'fontSizeDecrease',
	'fontSizeReset',
];

const ALL_SHORTCUTS = { ...FIXED_SHORTCUTS, ...TAB_SHORTCUTS, ...DEFAULT_SHORTCUTS };

describe('menu shortcut ids', () => {
	it('all resolve to a real binding', () => {
		const unresolved = MENU_SHORTCUT_IDS.filter((id) => !ALL_SHORTCUTS[id]);
		expect(unresolved).toEqual([]);
	});

	it('replay as an event that matches the shortcut they came from', () => {
		const { result } = renderHook(() =>
			useKeyboardShortcutHelpers({
				shortcuts: DEFAULT_SHORTCUTS,
				tabShortcuts: TAB_SHORTCUTS,
			})
		);
		const { isShortcut, isTabShortcut } = result.current;

		// Font size increase/decrease are matched by raw key checks in the main
		// handler rather than through isShortcut, so they have no matcher to assert
		// against here; buildEventFromKeys coverage lives in shortcutRecorder.test.ts.
		const matchable = MENU_SHORTCUT_IDS.filter(
			(id) => id !== 'fontSizeIncrease' && id !== 'fontSizeDecrease'
		);

		const unmatched = matchable.filter((id) => {
			const event = buildEventFromKeys(ALL_SHORTCUTS[id].keys);
			if (!event) return true;
			return DEFAULT_SHORTCUTS[id] ? !isShortcut(event, id) : !isTabShortcut(event, id);
		});

		expect(unmatched).toEqual([]);
	});
});

describe('useAppMenuBridge', () => {
	const setMenuShortcutKeys = vi.fn();
	const onMenuCommand = vi.fn(() => () => {});

	beforeEach(() => {
		vi.clearAllMocks();
		(window as unknown as { maestro: unknown }).maestro = {
			app: { setMenuShortcutKeys, onMenuCommand },
		};
		useSettingsStore.setState({
			shortcuts: DEFAULT_SHORTCUTS,
			tabShortcuts: TAB_SHORTCUTS,
		});
	});

	it('publishes global, tab and fixed bindings to the main process', () => {
		renderHook(() => useAppMenuBridge());

		const published = setMenuShortcutKeys.mock.calls.at(-1)?.[0] as Record<string, string[]>;
		expect(published['toggleMode']).toEqual(['Meta', 'j']); // global
		expect(published['closeTab']).toEqual(['Meta', 'w']); // tab
		expect(published['fontSizeIncrease']).toEqual(['Meta', '=']); // fixed
	});

	it('publishes a remapped binding rather than the bundled default', () => {
		useSettingsStore.setState({
			shortcuts: {
				...DEFAULT_SHORTCUTS,
				toggleMode: { ...DEFAULT_SHORTCUTS.toggleMode, keys: ['Alt', 'Meta', 'k'] },
			},
		});
		renderHook(() => useAppMenuBridge());

		const published = setMenuShortcutKeys.mock.calls.at(-1)?.[0] as Record<string, string[]>;
		expect(published['toggleMode']).toEqual(['Alt', 'Meta', 'k']);
	});

	it('replays a menu command as a keydown on window', () => {
		const dispatched: KeyboardEvent[] = [];
		const listener = (e: Event) => dispatched.push(e as KeyboardEvent);
		window.addEventListener('keydown', listener);

		renderHook(() => useAppMenuBridge());
		const emit = onMenuCommand.mock.calls.at(-1)?.[0] as unknown as (id: string) => void;
		emit('toggleMode');

		window.removeEventListener('keydown', listener);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].key).toBe('j');
		expect(dispatched[0].metaKey).toBe(true);
	});

	it('ignores a command whose shortcut no longer exists', () => {
		const dispatched: Event[] = [];
		const listener = (e: Event) => dispatched.push(e);
		window.addEventListener('keydown', listener);

		renderHook(() => useAppMenuBridge());
		const emit = onMenuCommand.mock.calls.at(-1)?.[0] as unknown as (id: string) => void;
		emit('someRemovedShortcut');

		window.removeEventListener('keydown', listener);
		expect(dispatched).toHaveLength(0);
	});

	it('no-ops when the app menu bridge is unavailable (web-desktop build)', () => {
		(window as unknown as { maestro: unknown }).maestro = { app: {} };
		expect(() => renderHook(() => useAppMenuBridge())).not.toThrow();
	});
});
