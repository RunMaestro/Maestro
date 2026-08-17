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

function itemNamed(menu: TemplateItem, label: string): TemplateItem {
	const found = menu.submenu?.find((item) => item.label === label);
	if (!found) throw new Error(`no "${label}" item in "${menu.label}" menu`);
	return found;
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

	it('never registers command accelerators with the OS', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'], closeTab: ['Meta', 'w'] });

		const commands = lastTemplate()
			.flatMap((menu) => menu.submenu ?? [])
			.filter((item) => item.accelerator && item.label !== 'Quit Maestro');

		expect(commands.length).toBeGreaterThan(0);
		for (const item of commands) {
			expect(item.registerAccelerator).toBe(false);
		}
	});

	it('keeps Cmd+W and Cmd+Z out of the natively-registered roles', () => {
		installApplicationMenu();

		const windowRoles = menuNamed('Window').submenu?.map((item) => item.role);
		expect(windowRoles).not.toContain('close');

		const editRoles = menuNamed('Edit').submenu?.map((item) => item.role);
		expect(editRoles).not.toContain('undo');
		expect(editRoles).not.toContain('redo');
	});

	it('renders the accelerator the renderer reported', () => {
		setMenuShortcutKeys({
			toggleMode: ['Meta', 'j'],
			toggleSidebar: ['Alt', 'Meta', 'ArrowLeft'],
			goToAutoRun: ['Meta', 'Shift', '1'],
			killInstance: ['Meta', 'Shift', 'Backspace'],
		});

		const view = menuNamed('View');
		expect(itemNamed(view, 'Switch AI / Shell Mode').accelerator).toBe('Cmd+J');
		expect(itemNamed(view, 'Toggle Left Panel').accelerator).toBe('Alt+Cmd+Left');
		expect(itemNamed(view, 'Auto Run').accelerator).toBe('Cmd+Shift+1');
		expect(itemNamed(menuNamed('File'), 'Remove Agent').accelerator).toBe('Cmd+Shift+Backspace');
	});

	it('follows a user remap instead of showing the bundled default', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });
		expect(itemNamed(menuNamed('View'), 'Switch AI / Shell Mode').accelerator).toBe('Cmd+J');

		setMenuShortcutKeys({ toggleMode: ['Alt', 'Meta', 't'] });
		expect(itemNamed(menuNamed('View'), 'Switch AI / Shell Mode').accelerator).toBe('Alt+Cmd+T');
	});

	it('omits the accelerator for shortcuts the renderer has not reported', () => {
		setMenuShortcutKeys({ toggleMode: ['Meta', 'j'] });

		expect(itemNamed(menuNamed('File'), 'New Agent').accelerator).toBeUndefined();
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
