/**
 * Quick Chat window tests.
 *
 * Reveal: the first show creates the window hidden and reveals it on the
 * FIRST of `ready-to-show` or a short delay after the page finishes loading.
 * `ready-to-show` alone left the first hotkey press after launch doing nothing,
 * because the transparent panel never emitted it. A hide that lands while the
 * reveal is pending cancels it, and status reports a pending show as visible.
 *
 * Bounds: the user resizes and moves the window, and both persist through the
 * bounds store. Width is the user's in both shapes; height only in the
 * conversation shape, because the composer-only shape is pinned to the
 * composer. Position persists only once the user drags the window, and a saved
 * spot that no longer lands on a display falls back on screen.
 *
 * The window lives in module state, so each test imports a fresh module.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { created, WORK_AREA } = vi.hoisted(() => ({
	created: [] as unknown[],
	WORK_AREA: { x: 0, y: 0, width: 1600, height: 1000 },
}));

vi.mock('electron', async () => {
	// vi.mock is hoisted above the file's imports, so the factory imports its own.
	const { EventEmitter } = await import('events');
	class MockBrowserWindow extends EventEmitter {
		visible = false;
		destroyed = false;
		bounds: { x: number; y: number; width: number; height: number };
		minimumSize = [0, 0];
		maximumSize = [0, 0];
		webContents = Object.assign(new EventEmitter(), {
			send: vi.fn(),
			setWindowOpenHandler: vi.fn(),
			getZoomFactor: vi.fn(() => 1),
		});
		show = vi.fn(() => {
			this.visible = true;
		});
		hide = vi.fn(() => {
			this.visible = false;
			this.emit('hide');
		});
		focus = vi.fn();
		loadURL = vi.fn();
		setAlwaysOnTop = vi.fn();
		setVisibleOnAllWorkspaces = vi.fn();
		setMinimumSize = vi.fn((w: number, h: number) => {
			this.minimumSize = [w, h];
		});
		setMaximumSize = vi.fn((w: number, h: number) => {
			this.maximumSize = [w, h];
		});
		// Like Electron, a programmatic setBounds fires move and resize (never will-move).
		setBounds = vi.fn((b) => {
			this.bounds = { ...b };
			this.emit('move');
			this.emit('resize');
		});
		getBounds = () => ({ ...this.bounds });
		isVisible = () => this.visible;
		isFocused = () => this.visible;
		isDestroyed = () => this.destroyed;
		close = () => {
			this.emit('close');
			this.destroyed = true;
			this.emit('closed');
		};
		constructor(opts: { x: number; y: number; width: number; height: number }) {
			super();
			this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
			created.push(this);
		}
	}
	return {
		BrowserWindow: MockBrowserWindow,
		screen: {
			getCursorScreenPoint: () => ({ x: 0, y: 0 }),
			getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
			getDisplayMatching: () => ({ workArea: WORK_AREA }),
			getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
		},
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../shared/platformDetection', () => ({
	isMacOS: () => true,
	isWindows: () => false,
	isLinux: () => false,
}));

type WindowModule = typeof import('../../../main/quick-chat/quick-chat-window');
type Bounds = { x: number; y: number; width: number; height: number };
type MockWindow = EventEmitter & {
	show: ReturnType<typeof vi.fn>;
	setAlwaysOnTop: ReturnType<typeof vi.fn>;
	webContents: EventEmitter & {
		send: ReturnType<typeof vi.fn>;
		getZoomFactor: ReturnType<typeof vi.fn>;
	};
	setBounds: (b: Bounds) => void;
	getBounds: () => Bounds;
	isVisible: () => boolean;
	minimumSize: number[];
	maximumSize: number[];
	close: () => void;
};
type SavedBounds = {
	x?: number;
	y?: number;
	width?: number;
	expandedHeight?: number;
	pinned?: boolean;
	fontScale?: number;
};

/** An in-memory bounds store, standing in for the window-state store. */
function makeDeps(initial?: SavedBounds) {
	const store = { value: initial };
	const deps = {
		isDevelopment: true,
		preloadPath: '/preload.js',
		rendererProductionUrl: 'app://renderer/index.html',
		devServerUrl: 'http://localhost:5173/',
		windowRegistry: { create: vi.fn(() => 'quick-window'), remove: vi.fn() },
		boundsStore: {
			get: () => store.value,
			set: (b: SavedBounds) => {
				store.value = b;
			},
		},
	} as unknown as Parameters<WindowModule['showQuickChatWindow']>[0];
	return { deps, store };
}

const { deps } = makeDeps();

async function freshModule(): Promise<WindowModule> {
	vi.resetModules();
	return import('../../../main/quick-chat/quick-chat-window');
}

function lastWindow(): MockWindow {
	return created[created.length - 1] as MockWindow;
}

describe('Quick Chat window reveal', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reveals a fresh window after the page loads even when ready-to-show never fires', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();

		expect(win.show).not.toHaveBeenCalled();
		// A status read right after the show reports the show it asked for.
		expect(mod.isQuickChatWindowVisible()).toBe(true);

		win.webContents.emit('did-finish-load');
		vi.runAllTimers();

		expect(win.show).toHaveBeenCalledTimes(1);
		expect(win.isVisible()).toBe(true);
	});

	it('reveals on ready-to-show without waiting, and only once', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();

		win.emit('ready-to-show');
		expect(win.show).toHaveBeenCalledTimes(1);

		win.webContents.emit('did-finish-load');
		vi.runAllTimers();
		expect(win.show).toHaveBeenCalledTimes(1);
	});

	it('does not reveal a fresh window hidden before it painted', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();

		mod.hideQuickChatWindow();
		expect(mod.isQuickChatWindowVisible()).toBe(false);

		win.emit('ready-to-show');
		win.webContents.emit('did-finish-load');
		vi.runAllTimers();
		expect(win.show).not.toHaveBeenCalled();
	});

	it('shows an existing window immediately', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(deps);
		const win = lastWindow();
		win.emit('ready-to-show');
		mod.hideQuickChatWindow();

		mod.showQuickChatWindow(deps);
		expect(created).toHaveLength(1);
		expect(win.show).toHaveBeenCalledTimes(2);
		expect(mod.isQuickChatWindowVisible()).toBe(true);
	});
});

describe('Quick Chat window bounds', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A user drag of the edges: Electron fires resize, never will-move. */
	function userResize(win: MockWindow, width: number, height: number) {
		win.setBounds({ ...win.getBounds(), width, height });
	}

	/** A user drag of the window: will-move first, then the move itself. */
	function userMove(win: MockWindow, x: number, y: number) {
		win.emit('will-move');
		win.setBounds({ ...win.getBounds(), x, y });
	}

	it('opens at the remembered size and spot', async () => {
		const { deps: d } = makeDeps({ x: 100, y: 120, width: 700, expandedHeight: 500 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();

		expect(win.getBounds()).toEqual({ x: 100, y: 120, width: 700, height: 148 });

		mod.setQuickChatLayout('expanded');
		expect(win.getBounds()).toEqual({ x: 100, y: 120, width: 700, height: 500 });
	});

	it('remembers a resize of the conversation, but not its position until the user moves it', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatLayout('expanded');

		userResize(win, 720, 540);
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ width: 720, expandedHeight: 540 });

		userMove(win, 300, 40);
		vi.advanceTimersByTime(1000);
		expect(store.value).toEqual({ x: 300, y: 40, width: 720, expandedHeight: 540 });
	});

	it('keeps the conversation height when the composer-only shape is resized', async () => {
		const { deps: d, store } = makeDeps({ width: 600, expandedHeight: 520 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();

		userResize(win, 640, 148);
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ width: 640, expandedHeight: 520 });
	});

	it('pins the composer-only height and frees it in the conversation shape', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(makeDeps().deps);
		const win = lastWindow();

		expect(win.minimumSize[1]).toBe(148);
		expect(win.maximumSize[1]).toBe(148);

		mod.setQuickChatLayout('expanded');
		// A finite limit, never Electron's 0: see NO_LIMIT.
		expect(win.maximumSize[0]).toBeGreaterThan(1000);
		expect(win.maximumSize[1]).toBeGreaterThan(1000);
		expect(win.minimumSize[1]).toBeGreaterThan(148);
	});

	it('grows the composer-only shape with the draft and shrinks it back', async () => {
		const { deps: d, store } = makeDeps({ x: 100, y: 120, width: 600, expandedHeight: 520 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();

		mod.setQuickChatCompactHeight(300);
		// The top edge stays; the height is pinned at the composer's.
		expect(win.getBounds()).toEqual({ x: 100, y: 120, width: 600, height: 300 });
		expect(win.minimumSize[1]).toBe(300);
		expect(win.maximumSize[1]).toBe(300);

		mod.setQuickChatCompactHeight(90);
		expect(win.getBounds().height).toBe(148);

		mod.setQuickChatCompactHeight(5000);
		expect(win.getBounds().height).toBe(480);

		vi.advanceTimersByTime(1000);
		// A draft's height is never the conversation's.
		expect(store.value?.expandedHeight).toBe(520);
	});

	it('sizes the composer-only shape in window pixels under a page zoom', async () => {
		const { deps: d, store } = makeDeps({ x: 100, y: 120, width: 600 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		// Chromium zooms per origin: a zoom left on the main window lands here.
		win.webContents.getZoomFactor.mockReturnValue(1.1);

		// The first report is the default height, which still needs a taller window.
		mod.setQuickChatCompactHeight(148);
		expect(win.getBounds().height).toBe(163);
		expect(win.maximumSize[1]).toBe(163);

		mod.setQuickChatCompactHeight(300);
		expect(win.getBounds().height).toBe(330);

		// Zoomed out, the window goes below COMPACT_HEIGHT and its spot still saves.
		win.webContents.getZoomFactor.mockReturnValue(0.9);
		mod.setQuickChatCompactHeight(148);
		expect(win.getBounds().height).toBe(133);
		win.emit('will-move');
		win.setBounds({ ...win.getBounds(), x: 40, y: 60 });
		vi.advanceTimersByTime(1000);
		expect(store.value).toMatchObject({ x: 40, y: 60, width: 600 });
	});

	it('stops a growing draft at the bottom of the display', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(makeDeps({ x: 100, y: 800, width: 600 }).deps);
		const win = lastWindow();

		mod.setQuickChatCompactHeight(400);
		expect(win.getBounds()).toMatchObject({ y: 800, height: 200 });
	});

	it('keeps the draft height for the composer-only shape while the conversation shows', async () => {
		const mod = await freshModule();
		mod.showQuickChatWindow(makeDeps({ expandedHeight: 520 }).deps);
		const win = lastWindow();
		mod.setQuickChatLayout('expanded');

		mod.setQuickChatCompactHeight(260);
		expect(win.getBounds().height).toBe(520);

		mod.setQuickChatLayout('compact');
		expect(win.getBounds().height).toBe(260);
	});

	it('saves a resize still settling when the shape changes', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatLayout('expanded');

		userResize(win, 560, 480);
		mod.setQuickChatLayout('compact');
		vi.advanceTimersByTime(1000);

		expect(store.value?.expandedHeight).toBe(480);
	});

	it('saves immediately when the window is put away', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		win.emit('ready-to-show');

		userMove(win, 50, 60);
		mod.hideQuickChatWindow();

		expect(store.value).toMatchObject({ x: 50, y: 60 });
	});

	it('brings a remembered spot that is no longer on a display back on screen', async () => {
		const { deps: d } = makeDeps({ x: 5000, y: 4000, width: 560 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const b = lastWindow().getBounds();

		expect(b.x).toBeGreaterThanOrEqual(0);
		expect(b.x + b.width).toBeLessThanOrEqual(WORK_AREA.width);
		expect(b.y).toBeLessThan(WORK_AREA.height);
	});

	it('ignores a corrupt saved size', async () => {
		const { deps: d } = makeDeps({ width: Number.NaN, expandedHeight: -5 } as SavedBounds);
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatLayout('expanded');

		expect(win.getBounds().width).toBe(560);
		expect(win.getBounds().height).toBe(600);
	});

	it('keeps the size the user left when the window is torn down', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow() as MockWindow & { bounds: Bounds };
		mod.setQuickChatLayout('expanded');

		// The user's last resize is still settling when the app quits.
		userResize(win, 700, 500);
		// Teardown: the closing window reports geometry nobody chose, then fires
		// its own resize on the way out.
		win.close();
		win.bounds = { x: 1619, y: 592, width: 0, height: 148 };
		win.emit('resize');
		win.emit('will-move');
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ width: 700, expandedHeight: 500 });
	});

	it('drops geometry smaller than the window can be', async () => {
		const { deps: d, store } = makeDeps({ width: 640, expandedHeight: 520 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatLayout('expanded');
		vi.advanceTimersByTime(1000);

		win.setBounds({ ...win.getBounds(), width: 0, height: 148 });
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ width: 640, expandedHeight: 520 });
	});

	it('applies and remembers a size and spot set from the CLI', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();

		mod.setQuickChatWindowBounds({ x: 250, y: 90, width: 640, height: 450 }, d);

		// Composer-only shape: the conversation height is remembered, not applied.
		expect(win.getBounds()).toEqual({ x: 250, y: 90, width: 640, height: 148 });
		expect(store.value).toEqual({ x: 250, y: 90, width: 640, expandedHeight: 450 });

		mod.setQuickChatLayout('expanded');
		expect(win.getBounds()).toEqual({ x: 250, y: 90, width: 640, height: 450 });
	});

	it('remembers bounds set from the CLI before the window ever opened', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();

		mod.setQuickChatWindowBounds({ width: 620 }, d);
		expect(store.value).toEqual({ width: 620 });

		mod.showQuickChatWindow(d);
		expect(lastWindow().getBounds().width).toBe(620);
	});
});

describe('Quick Chat window pin', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('floats on top by default', async () => {
		const { deps: d } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		expect(lastWindow().setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
		expect(mod.isQuickChatWindowPinned(d)).toBe(true);
	});

	it('unpins the live window, tells it, and remembers the choice', async () => {
		const { deps: d, store } = makeDeps({ width: 640 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();

		mod.setQuickChatWindowPinned(false, d);

		expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
		expect(win.webContents.send).toHaveBeenCalledWith('quickChat:pinned', false);
		expect(store.value).toEqual({ width: 640, pinned: false });
		expect(mod.isQuickChatWindowPinned(d)).toBe(false);
	});

	it('keeps the pin when a later drag saves the bounds', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatWindowPinned(false, d);

		win.setBounds({ ...win.getBounds(), width: 700 });
		vi.advanceTimersByTime(1000);

		expect(store.value).toMatchObject({ width: 700, pinned: false });
	});

	it('floats an unpinned window for a summon, then lets it settle back on blur', async () => {
		const { deps: d } = makeDeps({ pinned: false });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false, 'floating');

		win.emit('ready-to-show');
		// Raised BEFORE it shows, so it cannot land behind the active app's window.
		expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
		expect(win.setAlwaysOnTop.mock.invocationCallOrder.at(-1)).toBeLessThan(
			win.show.mock.invocationCallOrder[0]
		);

		win.emit('blur');
		expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
	});

	it('keeps a window the user pinned while it was floating for a summon', async () => {
		const { deps: d } = makeDeps({ pinned: false });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		win.emit('ready-to-show');

		mod.setQuickChatWindowPinned(true, d);
		win.emit('blur');
		expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
	});

	it('settles back once however many times it was summoned', async () => {
		const { deps: d } = makeDeps({ pinned: false });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		win.emit('ready-to-show');
		mod.showQuickChatWindow(d);
		mod.showQuickChatWindow(d);
		expect(win.listenerCount('blur')).toBe(1);
	});

	it('leaves a pinned window at its level when summoned', async () => {
		const { deps: d } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		win.emit('ready-to-show');
		expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(1);
		expect(win.listenerCount('blur')).toBe(0);
	});
});

describe('Quick Chat window full view (diagram viewer)', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fills the display for a diagram and puts the window back after, saving nothing', async () => {
		const { deps: d, store } = makeDeps({ x: 100, y: 120, width: 700, expandedHeight: 500 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		mod.setQuickChatLayout('expanded');
		const win = lastWindow();
		vi.advanceTimersByTime(1000);
		const before = win.getBounds();
		const savedBefore = { ...store.value };

		mod.setQuickChatFullView(true);
		expect(win.getBounds()).toEqual(WORK_AREA);
		vi.advanceTimersByTime(1000);
		expect(store.value).toEqual(savedBefore);

		mod.setQuickChatFullView(false);
		expect(win.getBounds()).toEqual(before);
	});

	it('keeps the full-screen size when the chat changes shape underneath', async () => {
		const { deps: d } = makeDeps({ x: 100, y: 120, width: 700, expandedHeight: 500 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();

		mod.setQuickChatFullView(true);
		mod.setQuickChatLayout('expanded');
		expect(win.getBounds()).toEqual(WORK_AREA);

		// Given back in the shape the chat is in now.
		mod.setQuickChatFullView(false);
		expect(win.getBounds()).toEqual({ x: 100, y: 120, width: 700, height: 500 });
	});

	it('stays full screen when summoned again with the viewer still open', async () => {
		const { deps: d } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatFullView(true);
		mod.hideQuickChatWindow();
		mod.showQuickChatWindow(d);
		expect(win.getBounds()).toEqual(WORK_AREA);
	});

	it('ignores a repeated request', async () => {
		const { deps: d } = makeDeps({ x: 100, y: 120, width: 700 });
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatFullView(true);
		mod.setQuickChatFullView(true);
		mod.setQuickChatFullView(false);
		expect(win.getBounds()).toEqual({ x: 100, y: 120, width: 700, height: 148 });
		mod.setQuickChatFullView(false);
		expect(win.getBounds()).toEqual({ x: 100, y: 120, width: 700, height: 148 });
	});
});

describe('Quick Chat text zoom', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('defaults to 100%, steps, sets, resets, and clamps', async () => {
		const { deps: d } = makeDeps();
		const mod = await freshModule();
		expect(mod.getQuickChatFontScale(d)).toBe(1);
		expect(mod.setQuickChatFontScale({ step: 1 }, d)).toBe(1.1);
		expect(mod.setQuickChatFontScale({ step: -1 }, d)).toBe(1);
		expect(mod.setQuickChatFontScale({ scale: 1.5 }, d)).toBe(1.5);
		expect(mod.setQuickChatFontScale({ scale: 9 }, d)).toBe(2);
		expect(mod.setQuickChatFontScale({ reset: true }, d)).toBe(1);
	});

	it('remembers the zoom with the window state, beside the pin and the size', async () => {
		const { deps: d, store } = makeDeps({ width: 700, pinned: false });
		const mod = await freshModule();
		mod.setQuickChatFontScale({ scale: 1.3 }, d);
		expect(store.value).toEqual({ width: 700, pinned: false, fontScale: 1.3 });

		// A fresh module is a restart: it reads the zoom back.
		const restarted = await freshModule();
		expect(restarted.getQuickChatFontScale(d)).toBe(1.3);
	});

	it('clamps a hand-edited stored zoom on load', async () => {
		const { deps: d } = makeDeps({ fontScale: 40 });
		const mod = await freshModule();
		expect(mod.getQuickChatFontScale(d)).toBe(2);
	});

	it('tells the open window so its text follows a CLI change', async () => {
		const { deps: d } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatFontScale({ step: 1 }, d);
		expect(win.webContents.send).toHaveBeenCalledWith('quickChat:fontScale', 1.1);
	});

	it('keeps the zoom when the user then resizes the window', async () => {
		const { deps: d, store } = makeDeps();
		const mod = await freshModule();
		mod.showQuickChatWindow(d);
		const win = lastWindow();
		mod.setQuickChatFontScale({ scale: 1.2 }, d);
		win.setBounds({ ...win.getBounds(), width: 720 });
		vi.advanceTimersByTime(1000);
		expect(store.value).toMatchObject({ width: 720, fontScale: 1.2 });
	});
});
