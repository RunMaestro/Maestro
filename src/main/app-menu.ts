/**
 * macOS application menu.
 *
 * Maestro is keyboard-first and every shortcut is matched in the renderer's
 * window keydown handler (`useMainKeyboardHandler`). That makes the native menu
 * a discovery surface rather than a dispatch surface: it exists so users can
 * *find* features and *learn* the keystroke, not so macOS can own the keystroke.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 * 1. Every command item sets `registerAccelerator: false`. The accelerator is
 *    still drawn next to the label, but it is NOT registered with NSMenu, so the
 *    keystroke continues to reach the renderer exactly as it does today. This is
 *    the same trap documented below for `role: 'close'` (Cmd+W) and `role: 'undo'`
 *    (Cmd+Z) - a registered accelerator is swallowed at the OS layer before the
 *    web contents ever sees it.
 * 2. Clicking an item does not call a handler directly. It sends the command's
 *    shortcut id to the focused window, and the renderer replays it as a
 *    synthetic keydown (see `useAppMenuBridge`). Menu clicks therefore run the
 *    exact same, already-tested code path as the keystroke - no parallel
 *    dispatch tree to keep in sync with App.tsx's handlers.
 *
 * The accelerators shown are the user's *current* bindings, not the bundled
 * defaults: the renderer pushes its merged shortcut map over IPC on mount and
 * whenever the user remaps something, and the menu is rebuilt from it.
 */

import { app, BrowserWindow, Menu } from 'electron';
import { isMacOS } from '../shared/platformDetection';
import { logger } from './utils/logger';

/** Map of shortcut id -> key array, e.g. `{ toggleMode: ['Meta', 'j'] }`. */
export type MenuShortcutKeys = Record<string, string[]>;

/** IPC channel the renderer listens on for menu clicks. */
export const MENU_COMMAND_CHANNEL = 'menu:command';

interface MenuCommand {
	label: string;
	/** Id from DEFAULT_SHORTCUTS / TAB_SHORTCUTS / FIXED_SHORTCUTS. */
	shortcutId: string;
}

type MenuEntry = MenuCommand | 'separator';

/**
 * Items appended to the app (Maestro) menu, after About. macOS users expect
 * Preferences to live here, and it is the one place nobody thinks to look for
 * an in-app button.
 */
const APP_MENU_COMMANDS: MenuEntry[] = [
	{ label: 'Settings...', shortcutId: 'settings' },
	{ label: 'Agent Settings...', shortcutId: 'agentSettings' },
	{ label: 'Keyboard Shortcuts', shortcutId: 'help' },
];

const FILE_MENU_COMMANDS: MenuEntry[] = [
	{ label: 'New Agent', shortcutId: 'newInstance' },
	{ label: 'New Agent (Wizard)...', shortcutId: 'openWizard' },
	{ label: 'New Group Chat', shortcutId: 'newGroupChat' },
	'separator',
	{ label: 'New Tab', shortcutId: 'newTab' },
	{ label: 'New File Tab', shortcutId: 'newFileTab' },
	{ label: 'New Browser Tab', shortcutId: 'newBrowserTab' },
	'separator',
	{ label: 'Find File...', shortcutId: 'fuzzyFileSearch' },
	{ label: 'Rename Tab', shortcutId: 'renameTab' },
	'separator',
	{ label: 'Close Tab', shortcutId: 'closeTab' },
	{ label: 'Close Other Tabs', shortcutId: 'closeOtherTabs' },
	{ label: 'Close All Tabs', shortcutId: 'closeAllTabs' },
	{ label: 'Reopen Closed Tab', shortcutId: 'reopenClosedTab' },
	'separator',
	{ label: 'Remove Agent', shortcutId: 'killInstance' },
];

const VIEW_MENU_COMMANDS: MenuEntry[] = [
	{ label: 'Toggle Left Panel', shortcutId: 'toggleSidebar' },
	{ label: 'Toggle Right Panel', shortcutId: 'toggleRightPanel' },
	'separator',
	{ label: 'Switch AI / Shell Mode', shortcutId: 'toggleMode' },
	{ label: 'Jump to Nearest Terminal', shortcutId: 'jumpToTerminal' },
	{ label: 'Clear Terminal', shortcutId: 'clearTerminal' },
	'separator',
	{ label: 'Files', shortcutId: 'goToFiles' },
	{ label: 'History', shortcutId: 'goToHistory' },
	{ label: 'Auto Run', shortcutId: 'goToAutoRun' },
	'separator',
	{ label: 'Previous Tab', shortcutId: 'prevTab' },
	{ label: 'Next Tab', shortcutId: 'nextTab' },
	{ label: 'Previous Agent', shortcutId: 'cyclePrev' },
	{ label: 'Next Agent', shortcutId: 'cycleNext' },
	'separator',
	{ label: 'Quick Actions...', shortcutId: 'quickAction' },
	{ label: 'Switch Agent...', shortcutId: 'agentSwitcher' },
	'separator',
	{ label: 'Usage Dashboard', shortcutId: 'usageDashboard' },
	{ label: 'System Log Viewer', shortcutId: 'systemLogs' },
	{ label: 'Process Monitor', shortcutId: 'processMonitor' },
	'separator',
	{ label: 'Increase Font Size', shortcutId: 'fontSizeIncrease' },
	{ label: 'Decrease Font Size', shortcutId: 'fontSizeDecrease' },
	{ label: 'Reset Font Size', shortcutId: 'fontSizeReset' },
];

/**
 * Renderer key names that Electron's accelerator parser spells differently.
 * Anything not listed passes through (single characters are uppercased, F-keys
 * and named keys like `Tab` / `Escape` already match).
 */
const ACCELERATOR_KEY_MAP: Record<string, string> = {
	meta: 'Cmd',
	command: 'Cmd',
	ctrl: 'Ctrl',
	control: 'Ctrl',
	alt: 'Alt',
	option: 'Alt',
	shift: 'Shift',
	arrowleft: 'Left',
	arrowright: 'Right',
	arrowup: 'Up',
	arrowdown: 'Down',
	enter: 'Return',
	' ': 'Space',
	space: 'Space',
};

/** Last shortcut map pushed by the renderer, used on every menu rebuild. */
let shortcutKeys: MenuShortcutKeys = {};
/** Serialized form of the above, so redundant pushes don't rebuild the menu. */
let shortcutKeysSignature = '';

/**
 * Convert a renderer key array into an Electron accelerator string.
 * Returns undefined when the shortcut is unknown or contains a key Electron
 * can't parse, in which case the item renders without an accelerator rather
 * than showing a wrong or broken one.
 */
function toAccelerator(shortcutId: string): string | undefined {
	const keys = shortcutKeys[shortcutId];
	if (!keys || keys.length === 0) return undefined;

	const parts: string[] = [];
	for (const key of keys) {
		const mapped = ACCELERATOR_KEY_MAP[key.toLowerCase()];
		if (mapped) {
			parts.push(mapped);
			continue;
		}
		if (key.length === 1) {
			parts.push(key.toUpperCase());
			continue;
		}
		// Function keys (F1-F24) and other multi-character names Electron knows.
		if (/^F\d{1,2}$/i.test(key) || /^[A-Za-z]+$/.test(key)) {
			parts.push(key);
			continue;
		}
		return undefined;
	}
	return parts.join('+');
}

/**
 * Route a menu click to the window it was invoked from (falling back to the
 * focused window, which is what the app menu reports since it has no owning
 * window, and what a non-BrowserWindow BaseWindow would leave us with).
 */
function sendMenuCommand(clickedWindow: Electron.BaseWindow | undefined, shortcutId: string): void {
	const target =
		clickedWindow instanceof BrowserWindow ? clickedWindow : BrowserWindow.getFocusedWindow();
	if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
	target.webContents.send(MENU_COMMAND_CHANNEL, shortcutId);
}

function buildSubmenu(entries: MenuEntry[]): Electron.MenuItemConstructorOptions[] {
	return entries.map((entry) =>
		entry === 'separator'
			? { type: 'separator' as const }
			: {
					label: entry.label,
					accelerator: toAccelerator(entry.shortcutId),
					// Display only - see rule 1 in the module comment.
					registerAccelerator: false,
					click: (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) =>
						sendMenuCommand(window, entry.shortcutId),
				}
	);
}

function buildTemplate(): Electron.MenuItemConstructorOptions[] {
	return [
		{
			// Explicit appMenu - uses a custom Quit item instead of `role: 'quit'`
			// so we can swallow Opt+Cmd+Q. macOS auto-binds Opt+Cmd+Q to any
			// quit role (as "Quit and Keep Windows"), and that keystroke sits
			// one modifier away from Opt+Q (Maestro Cue), causing accidental
			// quits. Click events from accelerators carry modifier flags, so
			// we can detect Option held and ignore the keystroke entirely.
			role: 'appMenu',
			submenu: [
				{ role: 'about' },
				{ type: 'separator' },
				...buildSubmenu(APP_MENU_COMMANDS),
				{ type: 'separator' },
				{ role: 'services' },
				{ type: 'separator' },
				{ role: 'hide' },
				{ role: 'hideOthers' },
				{ role: 'unhide' },
				{ type: 'separator' },
				{
					label: 'Quit Maestro',
					accelerator: 'Cmd+Q',
					click: (_item, _window, event) => {
						if (event?.altKey) {
							logger.info(
								'Ignoring Opt+Cmd+Q to prevent accidental quit (too close to Opt+Q for Maestro Cue)',
								'Menu'
							);
							return;
						}
						app.quit();
					},
				},
			],
		},
		{
			label: 'File',
			submenu: buildSubmenu(FILE_MENU_COMMANDS),
		},
		{
			// Custom Edit menu - equivalent to `role: 'editMenu'` minus
			// `undo` / `redo`. Those built-in roles register Cmd+Z /
			// Cmd+Shift+Z as NSMenu-level accelerators that intercept the
			// keystroke at the OS layer before the renderer can see it
			// (same trap as `role: 'close'` eating Cmd+W - see the note
			// at the top of this module). Removing them frees Cmd+Z for the
			// image annotator's stroke-undo handler.
			//
			// Side effect: Chromium in Electron relies on the Edit > Undo
			// menu role to deliver Cmd+Z to focused textareas/inputs on
			// macOS, so without it native text-field undo silently does
			// nothing. The renderer-side `useTextEditorUndo` hook
			// (src/renderer/hooks/keyboard/useTextEditorUndo.ts) restores
			// that behavior by calling `document.execCommand('undo')` on
			// text targets. The annotator's own Cmd+Z listener bails out
			// for text targets, so the two paths don't conflict.
			label: 'Edit',
			submenu: [
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'pasteAndMatchStyle' },
				{ role: 'delete' },
				{ type: 'separator' },
				{ role: 'selectAll' },
			],
		},
		{
			label: 'View',
			submenu: buildSubmenu(VIEW_MENU_COMMANDS),
		},
		{
			// IMPORTANT: Do NOT add { role: 'close' } here. It registers Cmd+W as a
			// native accelerator, which intercepts the keystroke at the NSMenu level
			// before it reaches the renderer, breaking Cmd+W tab-close in both AI and
			// terminal modes. Window closing is handled by the app lifecycle (Cmd+Q
			// quits, red traffic light hides) so the native Close item is unnecessary.
			label: 'Window',
			submenu: [{ role: 'minimize' }, { role: 'zoom' }],
		},
	];
}

/**
 * Install the application menu.
 *
 * On macOS this also prevents the OS from injecting native "Show Previous Tab"
 * (Cmd+Shift+{) and "Show Next Tab" (Cmd+Shift+}) items into the default Window
 * menu - without a custom menu those are intercepted at the NSMenu level and
 * never reach the renderer.
 *
 * On Windows/Linux the menu bar is removed entirely; Maestro uses its own UI.
 */
export function installApplicationMenu(): void {
	if (!isMacOS()) {
		Menu.setApplicationMenu(null);
		return;
	}
	Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
}

/**
 * Store the renderer's current shortcut bindings and rebuild the menu so the
 * displayed accelerators match what the user actually has bound. No-ops when
 * the bindings are unchanged, so multiple windows pushing the same map (or a
 * settings write that didn't touch shortcuts) doesn't thrash the menu.
 */
export function setMenuShortcutKeys(keys: MenuShortcutKeys): void {
	if (!isMacOS()) return;
	const signature = JSON.stringify(keys);
	if (signature === shortcutKeysSignature) return;
	shortcutKeysSignature = signature;
	shortcutKeys = keys;
	installApplicationMenu();
}

/** Test seam: drop the cached bindings so the next push always rebuilds. */
export function resetMenuShortcutKeysForTesting(): void {
	shortcutKeys = {};
	shortcutKeysSignature = '';
}
