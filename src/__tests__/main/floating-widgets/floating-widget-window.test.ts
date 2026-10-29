/**
 * Floating widget window controller tests.
 *
 * Lifecycle: the window is created on first use and only once, shows with
 * `showInactive()` (never `show()` or `focus()`, so it cannot steal focus from
 * the app the user types in), and reveals on the FIRST of `ready-to-show` or a
 * short delay after the page finishes loading. Hide keeps the window; close
 * destroys it and takes it out of the window registry.
 *
 * Bounds: moves and resizes persist through the bounds store once they settle,
 * right away on hide, never during teardown, and never below the widget's
 * minimum size. A saved spot no longer on a display is pulled back on screen.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	FLOATING_WIDGET_SPECS,
	NO_FLOATING_WIDGET_OVERFLOW as NO_OVERFLOW,
	type FloatingWidgetBounds,
} from '../../../shared/floatingWidgets';

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
		options: Record<string, unknown>;
		bounds: { x: number; y: number; width: number; height: number };
		webContents = Object.assign(new EventEmitter(), {
			send: vi.fn(),
			setWindowOpenHandler: vi.fn(),
		});
		show = vi.fn(() => {
			this.visible = true;
		});
		showInactive = vi.fn(() => {
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
		// Like Electron, a programmatic setBounds fires move and resize.
		setBounds = vi.fn((b) => {
			this.bounds = { ...b };
			this.emit('move');
			this.emit('resize');
		});
		getBounds = () => ({ ...this.bounds });
		isVisible = () => this.visible;
		isDestroyed = () => this.destroyed;
		close = vi.fn(() => {
			this.emit('close');
			this.destroyed = true;
			this.emit('closed');
		});
		constructor(
			opts: Record<string, unknown> & { x: number; y: number; width: number; height: number }
		) {
			super();
			this.options = opts;
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

import { createFloatingWidgetWindow } from '../../../main/floating-widgets/floating-widget-window';

type Bounds = { x: number; y: number; width: number; height: number };
type MockWindow = EventEmitter & {
	options: Record<string, unknown>;
	bounds: Bounds;
	show: ReturnType<typeof vi.fn>;
	showInactive: ReturnType<typeof vi.fn>;
	hide: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	loadURL: ReturnType<typeof vi.fn>;
	setAlwaysOnTop: ReturnType<typeof vi.fn>;
	setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
	webContents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
	setBounds: (b: Bounds) => void;
	getBounds: () => Bounds;
	isVisible: () => boolean;
	isDestroyed: () => boolean;
	close: () => void;
};

const GAUGE = FLOATING_WIDGET_SPECS['throughput-gauge'];
const MEDIA = FLOATING_WIDGET_SPECS['media-player'];

/** An in-memory bounds store and registry, standing in for the real ones. */
function makeDeps(initial?: FloatingWidgetBounds, overrides: { isDevelopment?: boolean } = {}) {
	const store: { value: FloatingWidgetBounds | undefined; writes: number } = {
		value: initial,
		writes: 0,
	};
	const windowRegistry = { create: vi.fn(() => 'widget-window'), remove: vi.fn() };
	const deps = {
		isDevelopment: overrides.isDevelopment ?? true,
		preloadPath: '/preload.js',
		rendererProductionUrl: 'app://renderer/index.html',
		devServerUrl: 'http://localhost:5173/',
		windowRegistry,
		boundsStore: {
			get: () => store.value,
			set: (b: FloatingWidgetBounds) => {
				store.value = b;
				store.writes += 1;
			},
		},
	} as unknown as Parameters<typeof createFloatingWidgetWindow>[1];
	return { deps, store, windowRegistry };
}

function lastWindow(): MockWindow {
	return created[created.length - 1] as MockWindow;
}

/** Let a fresh window paint, the way a transparent panel does: load, then the fallback. */
function paint(win: MockWindow) {
	win.webContents.emit('did-finish-load');
	vi.runOnlyPendingTimers();
}

/** A user drag of the window or its edges, settled. */
function userDrag(win: MockWindow, patch: Partial<Bounds>) {
	win.setBounds({ ...win.getBounds(), ...patch });
}

describe('floating widget window lifecycle', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates nothing until first used, then only one window', () => {
		const { deps, windowRegistry } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		expect(created).toHaveLength(0);
		expect(widget.getWindow()).toBeNull();

		widget.show();
		widget.show();
		widget.ensureCreated();
		widget.toggle();
		widget.show();

		expect(created).toHaveLength(1);
		expect(windowRegistry.create).toHaveBeenCalledTimes(1);
		expect(windowRegistry.create).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'floating-widget', isMain: false })
		);
	});

	it('floats on every workspace, full screen included', () => {
		const { deps } = makeDeps();
		createFloatingWidgetWindow(GAUGE, deps).ensureCreated();
		const win = lastWindow();
		expect(win.options).toMatchObject({ type: 'panel', frame: false, show: false });
		expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
		expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
			visibleOnFullScreen: true,
		});
	});

	it('loads the renderer with the widget id in the URL', () => {
		const dev = makeDeps();
		createFloatingWidgetWindow(GAUGE, dev.deps).ensureCreated();
		expect(lastWindow().loadURL).toHaveBeenCalledWith(
			'http://localhost:5173/?floatingWidget=throughput-gauge'
		);

		const prod = makeDeps(undefined, { isDevelopment: false });
		createFloatingWidgetWindow(FLOATING_WIDGET_SPECS['media-player'], prod.deps).ensureCreated();
		expect(lastWindow().loadURL).toHaveBeenCalledWith(
			'app://renderer/index.html?floatingWidget=media-player'
		);
	});

	it('shows without activating and never takes focus', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		win.emit('ready-to-show');
		widget.hide();
		widget.show();

		expect(win.showInactive).toHaveBeenCalledTimes(2);
		expect(win.show).not.toHaveBeenCalled();
		expect(win.focus).not.toHaveBeenCalled();
	});

	it('reveals after the page loads even when ready-to-show never fires', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();

		expect(win.showInactive).not.toHaveBeenCalled();
		// A status read right after the show reports the show it asked for.
		expect(widget.isVisible()).toBe(true);

		paint(win);
		expect(win.showInactive).toHaveBeenCalledTimes(1);
		expect(win.isVisible()).toBe(true);

		// A late ready-to-show does not reveal it a second time.
		win.emit('ready-to-show');
		expect(win.showInactive).toHaveBeenCalledTimes(1);
	});

	it('does not reveal a fresh window hidden before it painted', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();

		widget.hide();
		expect(widget.isVisible()).toBe(false);

		paint(win);
		expect(win.showInactive).not.toHaveBeenCalled();
	});

	it('creates a window for commands without showing it, and reveals it on a later show', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		const win = widget.ensureCreated() as unknown as MockWindow;
		paint(win);
		expect(win.showInactive).not.toHaveBeenCalled();
		expect(widget.isVisible()).toBe(false);

		widget.show();
		expect(win.showInactive).toHaveBeenCalledTimes(1);
	});

	it('hides without destroying the window, and toggles it back', () => {
		const { deps, windowRegistry } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		paint(win);

		widget.toggle();
		expect(win.hide).toHaveBeenCalledTimes(1);
		expect(win.isDestroyed()).toBe(false);
		expect(widget.getWindow()).toBe(win);
		expect(windowRegistry.remove).not.toHaveBeenCalled();

		widget.toggle();
		expect(widget.isVisible()).toBe(true);
		expect(created).toHaveLength(1);
	});

	it('closes the window and takes it out of the registry', () => {
		const { deps, windowRegistry } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		paint(lastWindow());

		widget.close();

		expect(windowRegistry.remove).toHaveBeenCalledWith('widget-window');
		expect(widget.getWindow()).toBeNull();
		expect(widget.getBounds()).toBeNull();
		expect(widget.isVisible()).toBe(false);

		// The next show builds a new window.
		widget.show();
		expect(created).toHaveLength(2);
	});

	it('tracks the renderer being ready, and forgets it on reload and close', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.markReady();
		// No window, nothing to be ready.
		expect(widget.isReady()).toBe(false);

		const win = widget.ensureCreated() as unknown as MockWindow;
		widget.markReady();
		expect(widget.isReady()).toBe(true);

		win.webContents.emit('did-start-loading');
		expect(widget.isReady()).toBe(false);

		widget.markReady();
		win.webContents.emit('render-process-gone');
		expect(widget.isReady()).toBe(false);

		widget.markReady();
		widget.close();
		expect(widget.isReady()).toBe(false);
	});

	it('does nothing while disabled', () => {
		const { deps } = makeDeps();
		let enabled = false;
		const widget = createFloatingWidgetWindow(GAUGE, { ...deps, isEnabled: () => enabled });

		widget.show();
		expect(widget.ensureCreated()).toBeNull();
		expect(created).toHaveLength(0);

		enabled = true;
		widget.show();
		expect(created).toHaveLength(1);
	});

	it('denies popups and navigation away from its own page', () => {
		const { deps } = makeDeps();
		createFloatingWidgetWindow(GAUGE, deps).ensureCreated();
		const win = lastWindow();

		const handler = win.webContents.setWindowOpenHandler.mock.calls[0][0];
		expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });

		const away = { url: 'https://example.com', preventDefault: vi.fn() };
		win.webContents.emit('will-navigate', away);
		expect(away.preventDefault).toHaveBeenCalled();

		const own = {
			url: 'http://localhost:5173/?floatingWidget=throughput-gauge',
			preventDefault: vi.fn(),
		};
		win.webContents.emit('will-navigate', own);
		expect(own.preventDefault).not.toHaveBeenCalled();
	});
});

describe('floating widget window bounds', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('opens bottom-right of the cursor display with a margin when nothing was saved', () => {
		const { deps } = makeDeps();
		createFloatingWidgetWindow(GAUGE, deps).ensureCreated();
		expect(lastWindow().getBounds()).toEqual({
			x: WORK_AREA.width - 300 - 24,
			y: WORK_AREA.height - 220 - 24,
			width: 300,
			height: 220,
		});
	});

	it('opens at the remembered size and spot', () => {
		const { deps } = makeDeps({ x: 100, y: 120, width: 360, height: 260 });
		createFloatingWidgetWindow(GAUGE, deps).ensureCreated();
		expect(lastWindow().getBounds()).toEqual({ x: 100, y: 120, width: 360, height: 260 });
	});

	it('raises a remembered size below the minimum to the minimum', () => {
		const { deps } = makeDeps({ x: 100, y: 120, width: 50, height: 40 });
		createFloatingWidgetWindow(GAUGE, deps).ensureCreated();
		expect(lastWindow().getBounds()).toEqual({ x: 100, y: 120, width: 200, height: 150 });
	});

	it('pulls a remembered spot that is no longer on a display back on screen', () => {
		const { deps } = makeDeps({ x: 5000, y: 4000, width: 300, height: 220 });
		createFloatingWidgetWindow(GAUGE, deps).ensureCreated();
		const b = lastWindow().getBounds();

		expect(b.x).toBeGreaterThanOrEqual(WORK_AREA.x);
		expect(b.x + b.width).toBeLessThanOrEqual(WORK_AREA.x + WORK_AREA.width);
		expect(b.y).toBeGreaterThanOrEqual(WORK_AREA.y);
		expect(b.y + b.height).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height);
	});

	it('remembers a move and a resize once they settle', () => {
		const { deps, store } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		paint(win);

		userDrag(win, { x: 40, y: 50 });
		userDrag(win, { width: 340, height: 240 });
		expect(store.value).toBeUndefined();

		vi.advanceTimersByTime(1000);
		expect(store.value).toEqual({ x: 40, y: 50, width: 340, height: 240 });
		// A drag's flood of events collapses into one write.
		expect(store.writes).toBe(1);
	});

	it('saves right away when the window is put away', () => {
		const { deps, store } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		paint(win);

		userDrag(win, { x: 70, y: 80 });
		widget.hide();

		expect(store.value).toMatchObject({ x: 70, y: 80 });
	});

	it('keeps the bounds the user left when the window is torn down', () => {
		const { deps, store } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		paint(win);

		// The user's last drag is still settling when the window closes.
		userDrag(win, { x: 30, y: 40, width: 320, height: 230 });
		win.close();
		// Teardown: the closing window reports geometry nobody chose.
		win.bounds = { x: 1619, y: 592, width: 0, height: 0 };
		win.emit('resize');
		win.emit('move');
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ x: 30, y: 40, width: 320, height: 230 });
	});

	it('never saves a frame smaller than the widget can be', () => {
		const { deps, store } = makeDeps({ x: 10, y: 20, width: 300, height: 220 });
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		paint(win);

		userDrag(win, { width: 0, height: 220 });
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ x: 10, y: 20, width: 300, height: 220 });
		expect(store.writes).toBe(0);
	});

	it('applies and remembers bounds set by a caller, ignoring unusable fields', () => {
		const { deps, store } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.ensureCreated();

		const result = widget.setBounds({
			x: 250,
			y: 90,
			width: 120,
			height: Number.NaN,
		});

		// Width raised to the minimum; the bad height leaves the default.
		expect(result).toEqual({ x: 250, y: 90, width: 200, height: 220 });
		expect(store.value).toEqual({ x: 250, y: 90, width: 200 });
	});

	it('keeps a never-placed window where it is when only its size changes', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.ensureCreated();
		const before = lastWindow().getBounds();

		expect(widget.setBounds({ width: 320 })).toEqual({ ...before, width: 320 });
	});

	it('remembers bounds set before the window ever opened', () => {
		const { deps, store } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);

		expect(widget.setBounds({ x: 60, y: 70, width: 310, height: 230 })).toBeNull();
		expect(store.value).toEqual({ x: 60, y: 70, width: 310, height: 230 });

		widget.show();
		expect(lastWindow().getBounds()).toEqual({ x: 60, y: 70, width: 310, height: 230 });
	});

	it('reopens at the spot the user chose after a close', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(GAUGE, deps);
		widget.show();
		const win = lastWindow();
		paint(win);
		userDrag(win, { x: 400, y: 300 });
		widget.close();

		widget.show();
		expect(lastWindow().getBounds()).toMatchObject({ x: 400, y: 300 });
	});
});

describe('floating widget window overflow', () => {
	beforeEach(() => {
		created.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A painted media window whose card sits at `y` in the 1000px-tall work area. */
	function mediaAt(y: number) {
		const made = makeDeps({ x: 100, y, width: 420, height: 96 });
		const widget = createFloatingWidgetWindow(MEDIA, made.deps);
		widget.show();
		const win = lastWindow();
		paint(win);
		return { ...made, widget, win };
	}

	it('grows the window below the card when there is room, and reports the card alone', () => {
		const { widget, win } = mediaAt(100);

		expect(widget.setOverflow({ above: 330, below: 280 })).toEqual({ above: 0, below: 280 });
		expect(win.getBounds()).toEqual({ x: 100, y: 100, width: 420, height: 376 });
		expect(widget.getBounds()).toEqual({ x: 100, y: 100, width: 420, height: 96 });
	});

	it('grows above the card when it sits at the bottom of the screen', () => {
		const { widget, win } = mediaAt(880);

		expect(widget.setOverflow({ above: 330, below: 280 })).toEqual({ above: 330, below: 0 });
		expect(win.getBounds()).toEqual({ x: 100, y: 550, width: 420, height: 426 });
		expect(widget.getBounds()).toEqual({ x: 100, y: 880, width: 420, height: 96 });
	});

	it('never saves the borrowed room as the window size', () => {
		const { widget, store } = mediaAt(100);

		widget.setOverflow({ above: 0, below: 280 });
		vi.advanceTimersByTime(1000);

		expect(store.value).toEqual({ x: 100, y: 100, width: 420, height: 96 });
	});

	it('keeps a drag made while the room is borrowed, then gives the room back', () => {
		const { widget, win, store } = mediaAt(880);
		widget.setOverflow({ above: 330, below: 280 });

		userDrag(win, { x: 200, y: 450 });
		vi.advanceTimersByTime(1000);
		expect(store.value).toEqual({ x: 200, y: 780, width: 420, height: 96 });

		expect(widget.setOverflow(NO_OVERFLOW)).toEqual(NO_OVERFLOW);
		expect(win.getBounds()).toEqual({ x: 200, y: 780, width: 420, height: 96 });
	});

	it('gives the room back on hide and on reload', () => {
		const { widget, win } = mediaAt(100);

		widget.setOverflow({ above: 0, below: 280 });
		widget.hide();
		expect(win.getBounds()).toEqual({ x: 100, y: 100, width: 420, height: 96 });

		widget.show();
		widget.setOverflow({ above: 0, below: 280 });
		win.webContents.emit('did-start-loading');
		expect(win.getBounds()).toEqual({ x: 100, y: 100, width: 420, height: 96 });
	});

	it('keeps the borrowed room around a caller resize', () => {
		const { widget, win } = mediaAt(100);
		widget.setOverflow({ above: 0, below: 280 });

		expect(widget.setBounds({ height: 300 })).toEqual({ x: 100, y: 100, width: 420, height: 300 });
		expect(win.getBounds()).toEqual({ x: 100, y: 100, width: 420, height: 580 });
	});

	it('grants nothing without a window', () => {
		const { deps } = makeDeps();
		const widget = createFloatingWidgetWindow(MEDIA, deps);
		expect(widget.setOverflow({ above: 0, below: 280 })).toEqual(NO_OVERFLOW);
	});
});
