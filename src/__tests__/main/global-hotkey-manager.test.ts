/**
 * @file global-hotkey-manager.test.ts
 * @description Accelerator translation and the named-binding registry that lets
 * Quick Chat hold its own system-wide hotkey beside "show Maestro".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registered = new Map<string, () => void>();
const register = vi.fn((accelerator: string, cb: () => void) => {
	if (registered.has(accelerator)) return false;
	registered.set(accelerator, cb);
	return true;
});
const unregister = vi.fn((accelerator: string) => {
	registered.delete(accelerator);
});

const { app, hideQuickChatWindow } = vi.hoisted(() => ({
	app: { show: vi.fn(), focus: vi.fn() },
	hideQuickChatWindow: vi.fn(),
}));

vi.mock('electron', () => ({
	app,
	BrowserWindow: class {},
	globalShortcut: {
		register: (a: string, cb: () => void) => register(a, cb),
		unregister: (a: string) => unregister(a),
	},
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/platformDetection', () => ({ isMacOS: () => true }));
vi.mock('../../main/quick-chat/quick-chat-window', () => ({
	hideQuickChatWindow: () => hideQuickChatWindow(),
}));

import {
	disposeAllGlobalHotkeys,
	initGlobalHotkey,
	keysToAccelerator,
	setGlobalShowHotkey,
	setNamedGlobalHotkey,
} from '../../main/global-hotkey-manager';

beforeEach(() => {
	disposeAllGlobalHotkeys();
	registered.clear();
	register.mockClear();
	unregister.mockClear();
	app.show.mockClear();
	app.focus.mockClear();
	hideQuickChatWindow.mockClear();
});

describe('keysToAccelerator', () => {
	it('names the space bar however the recorder stored it', () => {
		expect(keysToAccelerator(['Alt', 'Space'])).toBe('Alt+Space');
		expect(keysToAccelerator(['Alt', ' '])).toBe('Alt+Space');
		// Option+Space on macOS reports a non-breaking space as the key.
		expect(keysToAccelerator(['Alt', ' '])).toBe('Alt+Space');
	});

	it('maps Meta to Command on macOS and upper-cases letters', () => {
		expect(keysToAccelerator(['Meta', 'Shift', 'm'])).toBe('Command+Shift+M');
	});

	it('rejects a combo with no main key', () => {
		expect(keysToAccelerator(['Alt'])).toBeNull();
		expect(keysToAccelerator([])).toBeNull();
	});
});

describe('setNamedGlobalHotkey', () => {
	it('holds one binding per owner, alongside the show hotkey', () => {
		const onQuickChat = vi.fn();
		expect(setGlobalShowHotkey(['Meta', 'Shift', 'M'])).toBe(true);
		expect(setNamedGlobalHotkey('quickChat', ['Alt', 'Space'], onQuickChat)).toBe(true);
		expect([...registered.keys()]).toEqual(['Command+Shift+M', 'Alt+Space']);

		registered.get('Alt+Space')!();
		expect(onQuickChat).toHaveBeenCalledTimes(1);
	});

	it('releases the previous combo when an owner re-binds', () => {
		setNamedGlobalHotkey('quickChat', ['Alt', 'Space'], vi.fn());
		setNamedGlobalHotkey('quickChat', ['Alt', 'k'], vi.fn());
		expect(unregister).toHaveBeenCalledWith('Alt+Space');
		expect([...registered.keys()]).toEqual(['Alt+K']);
	});

	it('clears a binding when given no keys', () => {
		setNamedGlobalHotkey('quickChat', ['Alt', 'Space'], vi.fn());
		expect(setNamedGlobalHotkey('quickChat', [], vi.fn())).toBe(true);
		expect(registered.size).toBe(0);
	});

	it('refuses a combo another Maestro binding already holds', () => {
		setGlobalShowHotkey(['Alt', 'Space']);
		expect(setNamedGlobalHotkey('quickChat', ['Alt', 'Space'], vi.fn())).toBe(false);
		// The show hotkey keeps working.
		expect([...registered.keys()]).toEqual(['Alt+Space']);
	});

	it('reports failure when the OS refuses the combo', () => {
		register.mockReturnValueOnce(false);
		expect(setNamedGlobalHotkey('quickChat', ['Alt', 'Space'], vi.fn())).toBe(false);
	});

	it('dispose releases every binding', () => {
		setGlobalShowHotkey(['Meta', 'Shift', 'M']);
		setNamedGlobalHotkey('quickChat', ['Alt', 'Space'], vi.fn());
		disposeAllGlobalHotkeys();
		expect(registered.size).toBe(0);
	});
});

describe('show Maestro hotkey', () => {
	it('puts Quick Chat away and brings the main window forward from another app', () => {
		const win = {
			isDestroyed: () => false,
			isMinimized: () => true,
			isVisible: () => false,
			restore: vi.fn(),
			show: vi.fn(),
			focus: vi.fn(),
		};
		initGlobalHotkey(() => win as unknown as Electron.BrowserWindow);
		setGlobalShowHotkey(['Meta', 'Shift', 'M']);

		registered.get('Command+Shift+M')!();

		expect(hideQuickChatWindow).toHaveBeenCalledTimes(1);
		expect(win.restore).toHaveBeenCalled();
		expect(win.show).toHaveBeenCalled();
		expect(app.show).toHaveBeenCalled();
		// The non-activating Quick Chat panel leaves another app frontmost.
		expect(app.focus).toHaveBeenCalledWith({ steal: true });
		expect(win.focus).toHaveBeenCalled();
	});
});
