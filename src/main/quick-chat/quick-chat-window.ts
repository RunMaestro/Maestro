/**
 * Quick Chat window - a small, frameless window summoned by a system-wide
 * hotkey. Pinned (the default), it floats above other windows; unpinned, it is
 * an ordinary window that falls behind whatever the user clicks next. It reuses the main renderer bundle loaded with
 * `?quickChat`, which boots into QuickChatRoot (the chat view only).
 *
 * Created lazily on first show and then only hidden, never closed, so the
 * hotkey brings it back instantly with the conversation intact. It owns no
 * agents; the conversation lives in an AI tab of the app window that owns the
 * chosen agent (see src/shared/quickChat.ts).
 *
 * On macOS it is a `panel`: it floats over full-screen apps and shows without
 * activating Maestro, so summoning it from another app does not pull the main
 * Maestro window forward.
 *
 * The user can resize it and move it, and both survive a restart (see
 * `QuickChatWindowBounds`). Width resizes in both shapes; height only in the
 * conversation shape. The composer-only shape is exactly the composer, so its
 * height follows the draft: the window reports the composer's height as it
 * grows and shrinks (see setQuickChatCompactHeight).
 */

import { BrowserWindow, screen } from 'electron';
import { isMacOS } from '../../shared/platformDetection';
import {
	QUICK_CHAT_COMPACT_HEIGHT as COMPACT_HEIGHT,
	QUICK_CHAT_MAX_COMPACT_HEIGHT as MAX_COMPACT_HEIGHT,
	QUICK_CHAT_MIN_EXPANDED_HEIGHT as MIN_EXPANDED_HEIGHT,
	QUICK_CHAT_MIN_WIDTH as MIN_WIDTH,
	type QuickChatBoundsRequest,
	type QuickChatFontScaleRequest,
	type QuickChatLayout,
	type QuickChatWindowBounds,
} from '../../shared/quickChat';
import {
	clampFontScale,
	FONT_SCALE_DEFAULT,
	FONT_SCALE_RANGE,
	stepScale,
} from '../../shared/scaleRange';
import {
	positiveNumber,
	resolveSavedWindowRect,
	sanitizeSavedBounds,
} from '../floating-widgets/window-bounds';
import { debounce, type DebouncedFunction } from '../utils/debounce';
import { logger } from '../utils/logger';
import type { WindowRegistry } from '../window-registry';
import { WINDOW_STATE_SAVE_DEBOUNCE_MS } from '../window-state-persistence';

/** Where the window's bounds persist (the per-device window-state store). */
export interface QuickChatBoundsStore {
	get(): QuickChatWindowBounds | undefined;
	set(bounds: QuickChatWindowBounds): void;
}

export interface QuickChatWindowDeps {
	isDevelopment: boolean;
	preloadPath: string;
	/** Custom-protocol URL used to load the production renderer. */
	rendererProductionUrl: string;
	/** Development server URL. */
	devServerUrl: string;
	windowRegistry: WindowRegistry;
	boundsStore: QuickChatBoundsStore;
	/**
	 * The window was put away (Escape, the close button, the hotkey, "Open as a
	 * tab"). Whatever was using it as its only surface, a voice session bound to
	 * Quick Chat for one, has to end with it.
	 */
	onHidden?: (windowId: string) => void;
}

const DEFAULT_WIDTH = 560;
/** Composer plus conversation, before the user resizes it. */
const DEFAULT_EXPANDED_HEIGHT = 600;
/** The window's top edge sits this far down the work area on first show. */
const TOP_OFFSET_RATIO = 0.2;
/** How long after the page loads a fresh window waits for its first paint. */
const FIRST_SHOW_FALLBACK_MS = 150;
/**
 * The "no limit" maximum. Electron's own unbounded value (0) is not used: a
 * mixed maximum (0 wide, 148 tall) and a later switch back to (0, 0) are not
 * reliably applied by the native window, and a stale 148 cap would stop the
 * user from dragging the conversation taller. A large finite limit always is.
 */
const NO_LIMIT = 10_000;

let quickWindow: BrowserWindow | null = null;
let quickWindowId: string | null = null;
let layout: QuickChatLayout = 'compact';
/**
 * The composer-only shape's height: the composer's own, as the window last
 * reported it, in the page's CSS pixels. The user cannot drag it; the draft
 * decides it. See compactWindowHeight for the window's height.
 */
let compactHeight = COMPACT_HEIGHT;
/** Set once the user drags the window (or a saved spot was restored). */
let userPlaced = false;
/** A show was asked for while a fresh window has not painted yet. */
let revealPending = false;
/** The remembered size and spot, loaded once from the bounds store. */
let saved: QuickChatWindowBounds | null = null;
/** The live window's pending bounds save, flushed before the shape changes. */
let pendingSave: DebouncedFunction<[Electron.Rectangle, QuickChatLayout, boolean, number]> | null =
	null;
/**
 * Where the window was before a diagram took it full screen, or null when no
 * diagram is open. While set, moves and resizes are the viewer's, not the
 * user's, and are never saved.
 */
let fullViewRestore: { bounds: Electron.Rectangle; layout: QuickChatLayout } | null = null;

/** The Quick Chat window, or null when it has not been created (or was closed). */
export function getQuickChatWindow(): BrowserWindow | null {
	return quickWindow && !quickWindow.isDestroyed() ? quickWindow : null;
}

/** The window's id in the window registry, or null when there is no window. */
export function getQuickChatWindowId(): string | null {
	return getQuickChatWindow() ? quickWindowId : null;
}

/**
 * Whether the Quick Chat window is on screen, or about to be: a show that is
 * waiting for a fresh window's first paint counts, so a status read right
 * after the show reports what the caller asked for.
 */
export function isQuickChatWindowVisible(): boolean {
	const win = getQuickChatWindow();
	return !!win && (win.isVisible() || revealPending);
}

function loadSaved(deps: QuickChatWindowDeps): QuickChatWindowBounds {
	if (saved) return saved;
	const raw = deps.boundsStore.get() ?? {};
	const { x, y, width } = sanitizeSavedBounds(raw);
	saved = {
		x,
		y,
		width,
		expandedHeight: positiveNumber(raw.expandedHeight),
		pinned: typeof raw.pinned === 'boolean' ? raw.pinned : undefined,
		fontScale:
			typeof raw.fontScale === 'number' && Number.isFinite(raw.fontScale)
				? clampFontScale(raw.fontScale)
				: undefined,
	};
	if (saved.x !== undefined && saved.y !== undefined) userPlaced = true;
	return saved;
}

function widthNow(): number {
	return Math.max(MIN_WIDTH, Math.round(saved?.width ?? DEFAULT_WIDTH));
}

/**
 * The page's zoom factor. Chromium keeps page zoom per origin, so a zoom left
 * on the main window (same origin) applies here too, and a CSS pixel is then
 * not a window pixel.
 */
function zoomFactor(win: BrowserWindow | null = getQuickChatWindow()): number {
	const zoom = win?.webContents.getZoomFactor();
	return zoom && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * The window height that shows a composer `cssHeight` CSS pixels tall. Under a
 * page zoom of 1.1, a 148px composer needs a 163px window, or its bottom row
 * (the Send button) is clipped.
 */
function compactWindowHeight(cssHeight: number, win?: BrowserWindow | null): number {
	return Math.round(cssHeight * zoomFactor(win));
}

function heightFor(next: QuickChatLayout): number {
	if (next === 'compact') return compactWindowHeight(compactHeight);
	return Math.max(
		MIN_EXPANDED_HEIGHT,
		Math.round(saved?.expandedHeight ?? DEFAULT_EXPANDED_HEIGHT)
	);
}

/** Centered on the display under the cursor, near the top of its work area. */
function defaultBounds(height: number): Electron.Rectangle {
	const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	const area = display.workArea;
	const width = Math.min(widthNow(), area.width);
	return {
		x: Math.round(area.x + (area.width - width) / 2),
		y: Math.round(area.y + area.height * TOP_OFFSET_RATIO),
		width,
		height: Math.min(height, area.height),
	};
}

/**
 * Where the window opens: the spot the user left it, when that spot is still
 * on a connected display, otherwise the default. The saved spot goes through
 * the same visibility check the app windows use, so an unplugged monitor
 * cannot leave the window off screen.
 */
function boundsFor(next: QuickChatLayout): Electron.Rectangle {
	const height = heightFor(next);
	if (!userPlaced) return defaultBounds(height);
	return resolveSavedWindowRect(saved, { width: widthNow(), height }) ?? defaultBounds(height);
}

/**
 * Resize limits per shape. The composer-only shape pins its height (min and
 * max both the height it is given); the conversation shape takes any height
 * above a floor. Loosen before moving to the new size and tighten after, or
 * the outgoing shape's limits clamp the incoming size.
 */
function applyLayout(win: BrowserWindow, next: QuickChatLayout, bounds: Electron.Rectangle): void {
	// The bounds' own height is in the floor: a zoomed-out page makes the
	// composer-only shape shorter than COMPACT_HEIGHT window pixels.
	win.setMinimumSize(MIN_WIDTH, Math.min(COMPACT_HEIGHT, MIN_EXPANDED_HEIGHT, bounds.height));
	win.setMaximumSize(NO_LIMIT, NO_LIMIT);
	win.setBounds(bounds);
	if (next === 'compact') {
		win.setMinimumSize(MIN_WIDTH, bounds.height);
		win.setMaximumSize(NO_LIMIT, bounds.height);
	} else {
		win.setMinimumSize(MIN_WIDTH, MIN_EXPANDED_HEIGHT);
	}
}

/**
 * Record the window's size (and its spot, once the user has placed it). The
 * height is recorded only in the conversation shape: the composer shape's
 * height is the draft's, and saving it would size the next conversation to it.
 *
 * Takes the bounds and shape as they were when the event fired, not when the
 * debounced save runs: by the time a save is flushed on close, the window is
 * being torn down and reports geometry nobody chose (a 0-wide frame was seen),
 * which would overwrite the size the user left it at. Anything smaller than
 * the window's own minimums is that kind of geometry, and is dropped.
 * `minHeight` is the composer-only shape's floor in window pixels, taken at
 * the event too: it moves with the page zoom (see compactWindowHeight).
 */
function recordBounds(
	b: Electron.Rectangle,
	shape: QuickChatLayout,
	placed: boolean,
	minHeight: number,
	deps: QuickChatWindowDeps
): void {
	if (b.width < MIN_WIDTH || b.height < minHeight) return;
	if (shape === 'expanded' && b.height < MIN_EXPANDED_HEIGHT) return;
	const next: QuickChatWindowBounds = {
		...saved,
		width: b.width,
		...(shape === 'expanded' ? { expandedHeight: b.height } : {}),
		...(placed ? { x: b.x, y: b.y } : {}),
	};
	if (
		saved &&
		saved.x === next.x &&
		saved.y === next.y &&
		saved.width === next.width &&
		saved.expandedHeight === next.expandedHeight
	) {
		return;
	}
	saved = next;
	deps.boundsStore.set(next);
}

function withQuickChatFlag(url: string): string {
	return url.includes('?') ? `${url}&quickChat` : `${url}?quickChat`;
}

function createQuickChatWindow(deps: QuickChatWindowDeps): BrowserWindow {
	loadSaved(deps);
	const win = new BrowserWindow({
		...boundsFor(layout),
		// Non-activating floating panel on macOS (see file header).
		...(isMacOS() ? { type: 'panel' } : {}),
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: true,
		resizable: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		show: false,
		webPreferences: {
			preload: deps.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	quickWindow = win;
	quickWindowId = deps.windowRegistry.create({
		browserWindow: win,
		kind: 'quick-chat',
		isMain: false,
		sessionIds: [],
	});

	win.setAlwaysOnTop(saved?.pinned !== false, 'floating');
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	applyLayout(win, layout, win.getBounds());

	const url = withQuickChatFlag(
		deps.isDevelopment ? deps.devServerUrl : deps.rendererProductionUrl
	);
	win.loadURL(url);

	// Once the window starts closing, its moves and resizes are teardown, not
	// the user, and must not reach the store (see recordBounds).
	let closing = false;

	// `will-move` fires only for a move the user makes, never for setBounds.
	win.on('will-move', () => {
		if (!closing) userPlaced = true;
	});

	// A live drag or resize fires a flood of events; save once it settles, and
	// right away when the window is put away or closed so a quit cannot drop it.
	const persist = debounce(
		(b: Electron.Rectangle, shape: QuickChatLayout, placed: boolean, minHeight: number) =>
			recordBounds(b, shape, placed, minHeight, deps),
		WINDOW_STATE_SAVE_DEBOUNCE_MS
	);
	const capture = () => {
		if (closing || win.isDestroyed() || fullViewRestore) return;
		persist(win.getBounds(), layout, userPlaced, compactWindowHeight(COMPACT_HEIGHT, win));
	};
	win.on('move', capture);
	win.on('resize', capture);
	win.on('hide', () => {
		persist.flush();
		if (quickWindow === win && quickWindowId) deps.onHidden?.(quickWindowId);
	});
	win.on('close', () => {
		closing = true;
		persist.flush();
	});
	pendingSave = persist;

	win.on('closed', () => {
		persist.cancel();
		if (pendingSave === persist) pendingSave = null;
		if (quickWindow !== win) return;
		if (quickWindowId) {
			deps.windowRegistry.remove(quickWindowId);
			quickWindowId = null;
		}
		quickWindow = null;
		revealPending = false;
		fullViewRestore = null;
		// The next window reloads the store, so a spot the user chose survives a
		// close (feature toggled off and on) the same way it survives a restart.
		saved = null;
		userPlaced = false;
		// The next window's composer reports its own height once it renders.
		compactHeight = COMPACT_HEIGHT;
	});

	// The window only ever shows its own bundle: deny popups and navigation away.
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	win.webContents.on('will-navigate', (e) => {
		if (e.url !== url) e.preventDefault();
	});

	logger.info('Quick Chat window created', 'QuickChat', {
		mode: deps.isDevelopment ? 'development' : 'production',
	});
	return win;
}

/**
 * Raise an unpinned window to the floating level until it loses focus, then
 * drop it back unless the user pinned it in the meantime.
 */
function floatUntilBlur(win: BrowserWindow): void {
	win.setAlwaysOnTop(true, 'floating');
	win.removeListener('blur', settleUnpinned);
	win.once('blur', settleUnpinned);
}

function settleUnpinned(): void {
	const win = getQuickChatWindow();
	if (win && saved?.pinned === false) win.setAlwaysOnTop(false);
}

/** Show and focus the window, creating it on first use. */
export function showQuickChatWindow(deps: QuickChatWindowDeps): BrowserWindow {
	const existing = getQuickChatWindow();
	const win = existing ?? createQuickChatWindow(deps);
	// Follow the cursor's display until the user places the window themselves.
	// A diagram still open full screen keeps the window at the display's size.
	if (!userPlaced && !fullViewRestore) win.setBounds(boundsFor(layout));
	const reveal = () => {
		revealPending = false;
		if (win.isDestroyed()) return;
		// Unpinned, the window sits at the normal level. A non-activating panel
		// shown there while another app is active lands BEHIND that app's window
		// (`moveTop` does not cross apps), so the hotkey looked dead outside
		// Maestro. A summon must be seen: float it for the show, and let it settle
		// back to the normal level once the user clicks away.
		if (saved?.pinned === false) floatUntilBlur(win);
		win.show();
		win.focus();
		win.webContents.send('quickChat:focusInput');
	};
	if (existing) {
		reveal();
		return win;
	}
	// A fresh window paints its first frame later; showing it before then
	// flashes an empty transparent rectangle. `ready-to-show` alone is not
	// enough: this transparent panel did not emit it (seen on macOS), which left
	// the first hotkey press after launch doing nothing. Whichever signal lands first
	// reveals the window, unless a hide arrived in between.
	revealPending = true;
	const revealIfStillWanted = () => {
		if (revealPending) reveal();
	};
	win.once('ready-to-show', revealIfStillWanted);
	win.webContents.once('did-finish-load', () => {
		setTimeout(revealIfStillWanted, FIRST_SHOW_FALLBACK_MS);
	});
	return win;
}

export function hideQuickChatWindow(): void {
	revealPending = false;
	const win = getQuickChatWindow();
	if (win?.isVisible()) win.hide();
}

/**
 * The hotkey's behavior: hidden -> show; shown but behind something -> focus;
 * shown and focused -> hide.
 */
export function toggleQuickChatWindow(deps: QuickChatWindowDeps): void {
	const win = getQuickChatWindow();
	if (win?.isVisible() && win.isFocused()) {
		hideQuickChatWindow();
		return;
	}
	showQuickChatWindow(deps);
}

/**
 * Grow to show the conversation, or shrink back to the composer, keeping the
 * top edge and the width the user chose.
 */
export function setQuickChatLayout(next: QuickChatLayout): void {
	if (next === layout) return;
	// Save a resize still settling under the outgoing shape first, or the
	// conversation height the user just dragged to is read back as the composer's.
	pendingSave?.flush();
	layout = next;
	const win = getQuickChatWindow();
	// A diagram holding the window full screen keeps it; the new shape applies
	// when the viewer closes (setQuickChatFullView).
	if (!win || fullViewRestore) return;
	const bounds = win.getBounds();
	applyLayout(win, next, { ...bounds, height: heightFor(next) });
}

/**
 * Follow the composer's height in the composer-only shape, so a draft that
 * grows past two lines grows the window instead of being clipped by it. The
 * top edge stays put and the window grows downward, stopping at the bottom of
 * its display (past that the draft scrolls). Kept but not applied while the
 * conversation shows; it applies on the way back to the composer-only shape.
 */
export function setQuickChatCompactHeight(height: number): void {
	if (!Number.isFinite(height)) return;
	compactHeight = Math.round(Math.min(MAX_COMPACT_HEIGHT, Math.max(COMPACT_HEIGHT, height)));
	const win = getQuickChatWindow();
	if (!win || layout !== 'compact' || fullViewRestore) return;
	// Compared in window pixels, not against the last report: the first report
	// of a zoomed page is the default CSS height, and its window still needs to
	// grow to fit it.
	const next = compactWindowHeight(compactHeight, win);
	const bounds = win.getBounds();
	if (next === bounds.height) return;
	const area = screen.getDisplayMatching(bounds).workArea;
	const room = area.y + area.height - bounds.y;
	applyLayout(win, 'compact', {
		...bounds,
		height: Math.max(compactWindowHeight(COMPACT_HEIGHT, win), Math.min(next, room)),
	});
}

/**
 * Take the whole display for the diagram viewer, or give it back. The window
 * is sized to fit a chat, which is far too small to read a diagram in, so the
 * viewer grows it to the work area of the display it is on and puts it back
 * exactly where it was afterwards. Nothing about the full-screen size is saved.
 */
export function setQuickChatFullView(on: boolean): void {
	const win = getQuickChatWindow();
	if (!win || on === (fullViewRestore !== null)) return;
	if (on) {
		pendingSave?.flush();
		const bounds = win.getBounds();
		fullViewRestore = { bounds, layout };
		win.setMinimumSize(MIN_WIDTH, Math.min(COMPACT_HEIGHT, MIN_EXPANDED_HEIGHT));
		win.setMaximumSize(NO_LIMIT, NO_LIMIT);
		win.setBounds(screen.getDisplayMatching(bounds).workArea);
		return;
	}
	const restore = fullViewRestore!;
	fullViewRestore = null;
	// The shape may have changed underneath the viewer (a reply arrived): keep
	// the spot and width, and take the height of the shape the chat is in now.
	// The composer-only height follows the draft, which may have changed too.
	const bounds =
		restore.layout === layout && layout === 'expanded'
			? restore.bounds
			: { ...restore.bounds, height: heightFor(layout) };
	applyLayout(win, layout, bounds);
}

/**
 * Move or resize the window the way a drag would, and remember it: the
 * CLI's `quick-chat bounds`. Validate first (validateQuickChatBoundsRequest).
 * `height` is the conversation shape's, so in the composer-only shape it is
 * remembered for the next conversation rather than applied now. A spot off
 * every display is brought back on screen, exactly as a restored one is.
 */
export function setQuickChatWindowBounds(
	request: QuickChatBoundsRequest,
	deps: QuickChatWindowDeps
): void {
	pendingSave?.flush();
	const next: QuickChatWindowBounds = { ...loadSaved(deps) };
	if (request.width !== undefined) next.width = Math.round(request.width);
	if (request.height !== undefined) next.expandedHeight = Math.round(request.height);
	if (request.x !== undefined && request.y !== undefined) {
		next.x = Math.round(request.x);
		next.y = Math.round(request.y);
		userPlaced = true;
	}
	saved = next;
	deps.boundsStore.set(next);
	// Under a full-screen diagram, the new spot is where the viewer gives it back.
	if (fullViewRestore) {
		fullViewRestore = { bounds: boundsFor(layout), layout };
		return;
	}
	const win = getQuickChatWindow();
	if (win) applyLayout(win, layout, boundsFor(layout));
}

/** Whether the window floats above other windows. Pinned unless the user unpinned it. */
export function isQuickChatWindowPinned(deps: QuickChatWindowDeps): boolean {
	return loadSaved(deps).pinned !== false;
}

/**
 * Float the window above other windows, or let it fall behind them, and
 * remember the choice. The pin button and `maestro-cli quick-chat pin` both
 * land here; the window is told so its button follows a CLI change.
 */
export function setQuickChatWindowPinned(next: boolean, deps: QuickChatWindowDeps): void {
	pendingSave?.flush();
	saved = { ...loadSaved(deps), pinned: next };
	deps.boundsStore.set(saved);
	const win = getQuickChatWindow();
	if (!win) return;
	win.setAlwaysOnTop(next, 'floating');
	win.webContents.send('quickChat:pinned', next);
}

/** The conversation's text zoom (1 = normal). */
export function getQuickChatFontScale(deps: QuickChatWindowDeps): number {
	return loadSaved(deps).fontScale ?? FONT_SCALE_DEFAULT;
}

/**
 * Change the conversation's text zoom and remember it with the window's other
 * per-device state, so it survives a hide, a close, and a restart. The window's
 * buttons and chords and `maestro-cli quick-chat font` all land here; the window
 * is told so its text follows a CLI change. Returns the new zoom.
 */
export function setQuickChatFontScale(
	request: QuickChatFontScaleRequest,
	deps: QuickChatWindowDeps
): number {
	const current = getQuickChatFontScale(deps);
	const next =
		'reset' in request
			? FONT_SCALE_DEFAULT
			: 'step' in request
				? stepScale(current, request.step, FONT_SCALE_RANGE)
				: clampFontScale(request.scale);
	if (next === current) return current;
	pendingSave?.flush();
	saved = { ...loadSaved(deps), fontScale: next };
	deps.boundsStore.set(saved);
	getQuickChatWindow()?.webContents.send('quickChat:fontScale', next);
	return next;
}

/** The window's current bounds, for `quick-chat status`. */
export function getQuickChatWindowBounds(): Electron.Rectangle | null {
	return getQuickChatWindow()?.getBounds() ?? null;
}

/** Destroy the window outright (feature switched off, primary window closing). */
export function closeQuickChatWindow(): void {
	getQuickChatWindow()?.close();
}
