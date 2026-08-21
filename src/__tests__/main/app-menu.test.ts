import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setApplicationMenu, buildFromTemplate, send, getFocusedWindow, FakeBrowserWindow } =
	vi.hoisted(() => {
		const send = vi.fn();
		return {
			setApplicationMenu: vi.fn(),
			buildFromTemplate: vi.fn((template: unknown) => ({ template })),
			send,
			getFocusedWindow: vi.fn(),
			FakeBrowserWindow: class {
				isDestroyed = () => false;
				webContents = { isDestroyed: () => false, send };
			},
		};
	});

vi.mock('electron', () => ({
	app: { quit: vi.fn() },
	Menu: {
		setApplicationMenu: (...args: unknown[]) => setApplicationMenu(...args),
		buildFromTemplate: (...args: unknown[]) => buildFromTemplate(args[0]),
	},
	BrowserWindow: Object.assign(FakeBrowserWindow, {
		getFocusedWindow: () => getFocusedWindow(),
	}),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let isMac = true;
vi.mock('../../shared/platformDetection', () => ({
	isMacOS: () => isMac,
}));

import {
	installApplicationMenu,
	setMenuShortcutKeys,
	resetMenuShortcutKeysForTesting,
} from '../../main/app-menu';

interface TemplateItem {
	label?: string;
	role?: string;
	type?: string;
	accelerator?: string;
	registerAccelerator?: boolean;
	submenu?: TemplateItem[];
	click?: (item: unknown, window: unknown, event?: unknown) => void;
}

/** Last template handed to Menu.buildFromTemplate. */
function lastTemplate(): TemplateItem[] {
	return buildFromTemplate.mock.calls.at(-1)?.[0] as TemplateItem[];
}

function menuNamed(label: string): TemplateItem {
	const found = lastTemplate().find((item) => item.label === label);
	if (!found) throw new Error(`no "${label}" menu in template`);
	return found;
}

/**
 * Find an item by its command name. Labels carry the keystroke appended after a
 * run of en-spaces (see `labelWithShortcut`), so match on the name portion.
 */
function itemNamed(menu: TemplateItem, label: string): TemplateItem {
	const found = menu.submenu?.find((item) => nameOf(item) === label);
	if (!found) throw new Error(`no "${label}" item in "${menu.label}" menu`);
	return found;
}

/** The command name half of a menu label, with any keystroke stripped. */
function nameOf(item: TemplateItem): string {
	return (item.label ?? '').split('\u2002')[0];
}

/** The keystroke half of a menu label, or undefined when none is shown. */
function shortcutOf(item: TemplateItem): string | undefined {
	const parts = (item.label ?? '').split(/\u2002+/);
	return parts.length > 1 ? parts[1] : undefined;
}

describe('app menu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetMenuShortcutKeysForTesting();
		isMac = true;
	});

	it('installs File, Edit, View and Window menus on macOS', () => {
		installApplicationMenu();

		const labels = lastTemplate().map((item) => item.label ?? item.role);
		expect(labels).toEqual(['appMenu', 'File', 'Edit', 'View', 'Window']);
	});

	it('removes the menu bar entirely off macOS', () => {
		isMac = false;
		installApplicationMenu();

		expect(setApplicationMenu).toHaveBeenCalledWith(null);
		expect(buildFromTemplate).not.toHaveBeenCalled();
	});

	// The whole design rests on the renderer keeping ownership of every
	// keystroke. An `accelerator` on a command item hands it to NSMenu instead,
	// which swallows the keydown before the web contents ever sees it -
	// including Option+N, which macOS users press to type an 'n'.
	//
	// `registerAccelerator: false` does NOT prevent that here: Electron marks it
	// `@platform linux,win32` and macOS ignores it, so the only safe answer is
	// to not set an accelerator at all. Quit is the single exception, and it is
	// deliberate: Cmd+Q is a real OS-level action and its handler reads the
	// click event's modifier flags to swallow Opt+Cmd+Q.
	it('never sets an accelerator on a command item', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'], closeTab: ['Meta', 'w'] });

		const commands = lastTemplate()
			.flatMap((menu) => menu.submenu ?? [])
			.filter((item) => item.click && item.label !== 'Quit Maestro');

		expect(commands.length).toBeGreaterThan(0);
		for (const item of commands) {
			expect(item.accelerator).toBeUndefined();
		}
	});

	it('still shows the keystroke, as label text rather than an accelerator', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		const item = itemNamed(menuNamed('View'), 'Switch AI / Shell Mode');
		expect(item.label).toContain('⌘J');
		expect(item.accelerator).toBeUndefined();
	});

	it('keeps Cmd+W and Cmd+Z out of the natively-registered roles', () => {
		installApplicationMenu();

		const windowRoles = menuNamed('Window').submenu?.map((item) => item.role);
		expect(windowRoles).not.toContain('close');

		const editRoles = menuNamed('Edit').submenu?.map((item) => item.role);
		expect(editRoles).not.toContain('undo');
		expect(editRoles).not.toContain('redo');
	});

	it('renders the keystroke the renderer reported, in macOS symbols', () => {
		setMenuShortcutKeys({
			toggleMode: ['Meta', 'j'],
			toggleSidebar: ['Alt', 'Meta', 'ArrowLeft'],
			goToAutoRun: ['Meta', 'Shift', '1'],
			killInstance: ['Meta', 'Shift', 'Backspace'],
		});

		const view = menuNamed('View');
		expect(shortcutOf(itemNamed(view, 'Switch AI / Shell Mode'))).toBe('⌘J');
		expect(shortcutOf(itemNamed(view, 'Toggle Left Panel'))).toBe('⌥⌘←');
		expect(shortcutOf(itemNamed(view, 'Auto Run'))).toBe('⌘⇧1');
		expect(shortcutOf(itemNamed(menuNamed('File'), 'Remove Agent'))).toBe('⌘⇧⌫');
	});

	it('follows a user remap instead of showing the bundled default', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });
		expect(shortcutOf(itemNamed(menuNamed('View'), 'Switch AI / Shell Mode'))).toBe('⌘J');

		setMenuShortcutKeys({ toggleMode: ['Alt', 'Meta', 't'] });
		expect(shortcutOf(itemNamed(menuNamed('View'), 'Switch AI / Shell Mode'))).toBe('⌥⌘T');
	});

	it('shows a bare name for shortcuts the renderer has not reported', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		const item = itemNamed(menuNamed('File'), 'New Agent');
		expect(item.label).toBe('New Agent');
		expect(shortcutOf(item)).toBeUndefined();
	});

	it('ignores a repeated push of identical bindings', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		expect(buildFromTemplate).toHaveBeenCalledTimes(1);
	});

	it('sends the clicked item shortcut id to the window it was invoked from', () => {
		installApplicationMenu();
		const window = new FakeBrowserWindow();

		itemNamed(menuNamed('View'), 'Switch AI / Shell Mode').click?.({}, window);

		expect(send).toHaveBeenCalledWith('menu:command', 'toggleMode');
		expect(getFocusedWindow).not.toHaveBeenCalled();
	});

	it('falls back to the focused window for app-menu items', () => {
		installApplicationMenu();
		const focused = new FakeBrowserWindow();
		getFocusedWindow.mockReturnValue(focused);

		const appMenu = lastTemplate().find((item) => item.role === 'appMenu')!;
		itemNamed(appMenu, 'Settings...').click?.({}, undefined);

		expect(send).toHaveBeenCalledWith('menu:command', 'settings');
	});

	it('does not send to a destroyed window', () => {
		installApplicationMenu();
		getFocusedWindow.mockReturnValue(null);

		itemNamed(menuNamed('File'), 'New Agent').click?.({}, undefined);

		expect(send).not.toHaveBeenCalled();
	});
});
