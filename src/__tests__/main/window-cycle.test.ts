import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getFocusedWindow, focusAppWindow } = vi.hoisted(() => ({
	getFocusedWindow: vi.fn(),
	focusAppWindow: vi.fn(),
}));

vi.mock('electron', () => ({
	BrowserWindow: { getFocusedWindow: () => getFocusedWindow() },
}));

vi.mock('../../main/global-hotkey-manager', () => ({
	focusAppWindow: (win: unknown) => focusAppWindow(win),
}));

import {
	attachWindowCycleShortcut,
	cycleWindows,
	windowCycleDirectionFor,
	windowCycleTargets,
} from '../../main/window-cycle';
import { WindowRegistry, type WindowKind } from '../../main/window-registry';

interface FakeWindow {
	name: string;
	visible: boolean;
	minimized: boolean;
	destroyed: boolean;
	isDestroyed: () => boolean;
	isVisible: () => boolean;
	isMinimized: () => boolean;
	focus: ReturnType<typeof vi.fn>;
}

function fakeWindow(name: string, state: Partial<FakeWindow> = {}): FakeWindow {
	const win: FakeWindow = {
		name,
		visible: true,
		minimized: false,
		destroyed: false,
		...state,
		isDestroyed: () => win.destroyed,
		isVisible: () => win.visible,
		isMinimized: () => win.minimized,
		focus: vi.fn(),
	};
	return win;
}

function register(registry: WindowRegistry, win: FakeWindow, kind: WindowKind): void {
	registry.create({ browserWindow: win as unknown as Electron.BrowserWindow, kind });
}

const asWindow = (win: FakeWindow) => win as unknown as Electron.BrowserWindow;

function input(overrides: Partial<Electron.Input>): Electron.Input {
	return {
		type: 'keyDown',
		key: '`',
		code: 'Backquote',
		isAutoRepeat: false,
		isComposing: false,
		shift: false,
		control: false,
		alt: false,
		meta: true,
		location: 0,
		modifiers: ['meta'],
		...overrides,
	} as Electron.Input;
}

describe('window cycle', () => {
	let registry: WindowRegistry;
	let main: FakeWindow;
	let quickChat: FakeWindow;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new WindowRegistry();
		main = fakeWindow('main');
		quickChat = fakeWindow('quick-chat');
		register(registry, main, 'app');
		register(registry, quickChat, 'quick-chat');
	});

	it('moves from Maestro to a visible Quick Chat with a plain focus', () => {
		expect(cycleWindows(registry, 'next', asWindow(main))).toBe(asWindow(quickChat));
		// The panel takes the keyboard without activating Maestro.
		expect(quickChat.focus).toHaveBeenCalledTimes(1);
		expect(focusAppWindow).not.toHaveBeenCalled();
	});

	it('moves from Quick Chat back to Maestro, activating the app, and leaves the chat up', () => {
		expect(cycleWindows(registry, 'next', asWindow(quickChat))).toBe(asWindow(main));
		expect(focusAppWindow).toHaveBeenCalledWith(main);
		expect(quickChat.focus).not.toHaveBeenCalled();
	});

	it('walks every app window in opening order and wraps, both directions', () => {
		const second = fakeWindow('second');
		register(registry, second, 'app');

		expect(windowCycleTargets(registry)).toEqual([main, quickChat, second].map(asWindow));
		expect(cycleWindows(registry, 'next', asWindow(quickChat))).toBe(asWindow(second));
		expect(cycleWindows(registry, 'next', asWindow(second))).toBe(asWindow(main));
		expect(cycleWindows(registry, 'previous', asWindow(main))).toBe(asWindow(second));
	});

	it('skips hidden, minimized, destroyed, and feature windows', () => {
		quickChat.visible = false;
		register(registry, fakeWindow('minimized', { minimized: true }), 'app');
		register(registry, fakeWindow('destroyed', { destroyed: true }), 'app');
		register(registry, fakeWindow('widget'), 'floating-widget');
		register(registry, fakeWindow('hud'), 'cadenza-hud');

		expect(windowCycleTargets(registry)).toEqual([asWindow(main)]);
		// Nowhere else to go from the only window.
		expect(cycleWindows(registry, 'next', asWindow(main))).toBeNull();
		expect(focusAppWindow).not.toHaveBeenCalled();
	});

	it('starts from the first window when focus is outside the cycle', () => {
		getFocusedWindow.mockReturnValue(null);
		expect(cycleWindows(registry, 'previous')).toBe(asWindow(main));
		expect(focusAppWindow).toHaveBeenCalledWith(main);
	});

	it('reads Cmd+` as next and Cmd+Shift+` as previous, and nothing else', () => {
		expect(windowCycleDirectionFor(input({}))).toBe('next');
		expect(windowCycleDirectionFor(input({ key: '~', shift: true }))).toBe('previous');
		expect(windowCycleDirectionFor(input({ type: 'keyUp' }))).toBeNull();
		expect(windowCycleDirectionFor(input({ meta: false, control: true }))).toBeNull();
		expect(windowCycleDirectionFor(input({ alt: true }))).toBeNull();
		expect(windowCycleDirectionFor(input({ code: 'KeyK', key: 'k' }))).toBeNull();
	});

	it('takes the keystroke from the page and cycles once per press', () => {
		let listener: ((event: { preventDefault: () => void }, input: Electron.Input) => void) | null =
			null;
		const webContents = {
			on: (_name: string, fn: typeof listener) => {
				listener = fn;
			},
		};
		const onCycle = vi.fn();
		attachWindowCycleShortcut(webContents as unknown as Electron.WebContents, onCycle);
		const press = (overrides: Partial<Electron.Input>) => {
			const event = { preventDefault: vi.fn() };
			listener!(event, input(overrides));
			return event.preventDefault;
		};

		expect(press({})).toHaveBeenCalled();
		expect(onCycle).toHaveBeenLastCalledWith('next');
		// A held key is still kept from the page, but does not cycle again.
		expect(press({ isAutoRepeat: true })).toHaveBeenCalled();
		expect(onCycle).toHaveBeenCalledTimes(1);
		expect(press({ code: 'KeyK', key: 'k' })).not.toHaveBeenCalled();
		expect(onCycle).toHaveBeenCalledTimes(1);
	});
});
