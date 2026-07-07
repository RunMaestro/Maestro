/**
 * Cadenza HUD window - a transparent, frameless, always-on-top child window
 * that floats the agent's cadenza views over other applications (a desktop
 * HUD). It reuses the main renderer bundle loaded with `?cadenzaHud`, which
 * boots into CadenzaHudRoot (floating cards only, transparent background).
 *
 * The window is created click-through by default (setIgnoreMouseEvents): a
 * transparent, screen-covering window must never trap clicks meant for the apps
 * beneath it. Interactivity is toggled on only while the cursor is over a card.
 *
 * Hover detection runs in the MAIN process by polling the global cursor position
 * (`screen.getCursorScreenPoint`) against card rectangles the renderer reports.
 * This is deliberately cross-platform: the obvious alternative,
 * `setIgnoreMouseEvents(true, { forward: true })` + renderer mouse-move
 * hit-testing, does NOT work on Linux (the `forward` option is Windows/macOS
 * only), which would leave cards permanently unclickable there.
 *
 * Created lazily on the first cadenza so an unused HUD never sits on top of
 * everything.
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import type { CadenzaPayload } from '../../shared/cadenza-types';
import { logger } from '../utils/logger';
import type { WindowRegistry } from '../window-registry';

/** A card's hit region in HUD-window content coordinates (CSS px == DIP). */
interface CardRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CadenzaHudWindowDeps {
	isDevelopment: boolean;
	preloadPath: string;
	/** Custom-protocol URL used to load the production renderer. */
	rendererProductionUrl: string;
	/** Development server URL. */
	devServerUrl: string;
	/** Window registry - the HUD registers as a `cadenza-hud` kind so it's tracked
	 *  uniformly and torn down through the registry on close. */
	windowRegistry: WindowRegistry;
}

let hudWindow: BrowserWindow | null = null;
/** Registry id for the HUD window, so its `closed` handler can deregister it. */
let hudWindowId: string | null = null;
/**
 * The Maestro main window that owns the HUD conceptually. The HUD is deliberately
 * NOT an OS child (`parent`) window: on Windows, clicking an owned window can
 * activate its owner, which pulls foreground away from whatever app the user is
 * working in (e.g. a browser playing a video pauses on blur). Instead we keep a
 * plain reference and manage lifecycle (close/hide/show) manually.
 */
let ownerWindow: BrowserWindow | null = null;
/**
 * The HUD renderer subscribes to `remote:cadenza` asynchronously (after mount),
 * so cadenzas are buffered here until it signals ready - otherwise the very
 * first cadenza (the one that lazily created the window) is dropped before any
 * listener exists. Reset whenever the window is (re)created.
 */
let hudReady = false;
let pendingPayloads: CadenzaPayload[] = [];
let listenersRegistered = false;

/** Latest card hit regions reported by the HUD renderer (window content coords). */
let cardRects: CardRect[] = [];
/** Cursor-hover poll handle; runs only while there are cards to hit-test. */
let hoverPoll: ReturnType<typeof setInterval> | null = null;
/** Last interactivity state pushed to the window, to avoid redundant toggles. */
let lastInteractive = false;
/** ~12 Hz: responsive enough for hover, negligible cost, only while cards exist. */
const HOVER_POLL_MS = 80;

/** The cadenza HUD window, or null if it isn't open. */
export function getCadenzaHudWindow(): BrowserWindow | null {
	return hudWindow && !hudWindow.isDestroyed() ? hudWindow : null;
}

/** Flush any cadenzas buffered while the HUD renderer was still booting. */
function flushPendingPayloads(): void {
	const win = getCadenzaHudWindow();
	if (!win || !hudReady) return;
	const queued = pendingPayloads;
	pendingPayloads = [];
	for (const payload of queued) {
		win.webContents.send('remote:cadenza', payload);
	}
}

/** Set click-through state on the HUD window, skipping redundant OS calls. */
function setHudInteractive(interactive: boolean): void {
	const win = getCadenzaHudWindow();
	if (!win) return;
	if (interactive === lastInteractive) return;
	lastInteractive = interactive;
	// `ignore = !interactive`. No `forward` option: hover detection is done by
	// polling in main (cross-platform), not by renderer mouse-move forwarding.
	win.setIgnoreMouseEvents(!interactive);
}

/** True when the global cursor is currently over one of the reported card rects. */
function cursorIsOverCard(win: BrowserWindow): boolean {
	if (cardRects.length === 0) return false;
	// getCursorScreenPoint and getContentBounds are both DIP in the same screen
	// coordinate space, so the subtraction yields window-content (page) coords.
	const cursor = screen.getCursorScreenPoint();
	const b = win.getContentBounds();
	const px = cursor.x - b.x;
	const py = cursor.y - b.y;
	return cardRects.some(
		(r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height
	);
}

/** Start/stop the hover poll based on whether any cards are present + visible. */
function syncHoverPoll(): void {
	const shouldRun = cardRects.length > 0 && !!getCadenzaHudWindow();
	if (shouldRun && !hoverPoll) {
		hoverPoll = setInterval(() => {
			const win = getCadenzaHudWindow();
			if (!win || !win.isVisible()) {
				setHudInteractive(false);
				return;
			}
			setHudInteractive(cursorIsOverCard(win));
		}, HOVER_POLL_MS);
	} else if (!shouldRun && hoverPoll) {
		clearInterval(hoverPoll);
		hoverPoll = null;
		setHudInteractive(false);
	}
}

/** Register the one-time HUD renderer -> main listeners (ready + card rects). */
function ensureHudListeners(): void {
	if (listenersRegistered) return;
	listenersRegistered = true;

	ipcMain.on('cadenza-hud:ready', (event) => {
		const win = getCadenzaHudWindow();
		// Only trust the ready signal from the actual HUD window's webContents.
		if (!win || event.sender !== win.webContents) return;
		hudReady = true;
		flushPendingPayloads();
	});

	// The renderer reports card hit regions (window content coords) whenever they
	// change; main polls the cursor against them to toggle click-through. This
	// replaces renderer mouse-move forwarding, which is unsupported on Linux.
	ipcMain.on('cadenza-hud:card-rects', (event, rects: CardRect[]) => {
		const win = getCadenzaHudWindow();
		if (!win || event.sender !== win.webContents) return;
		cardRects = Array.isArray(rects) ? rects : [];
		syncHoverPoll();
	});

	// Expand a file cadenza into the main window's File Preview tab. Forward to
	// the parent (main) renderer's existing remote open-file path, and raise it -
	// expanding is a deliberate "take me to Maestro", unlike ordinary card hover.
	ipcMain.on('cadenza-hud:open-file', (event, sessionId: string, filePath: string) => {
		const win = getCadenzaHudWindow();
		if (!win || event.sender !== win.webContents) return;
		if (!ownerWindow || ownerWindow.isDestroyed()) return;
		ownerWindow.webContents.send('remote:openFileTab', sessionId, filePath, true);
		if (ownerWindow.isMinimized()) ownerWindow.restore();
		ownerWindow.focus();
	});

	// Keep the HUD covering Maestro's monitor as displays change (resolution or
	// scale change, monitor added/removed).
	const resizeToDisplay = () => {
		const win = getCadenzaHudWindow();
		if (win) win.setBounds(computeHudBounds(ownerWindow));
	};
	screen.on('display-added', resizeToDisplay);
	screen.on('display-removed', resizeToDisplay);
	screen.on('display-metrics-changed', resizeToDisplay);
}

/** Append the `cadenzaHud` flag so main.tsx boots into HUD mode. */
function withHudFlag(url: string): string {
	return url.includes('?') ? `${url}&cadenzaHud` : `${url}?cadenzaHud`;
}

/**
 * Full bounds (NOT work area) of the display Maestro is on, so the HUD covers the
 * whole monitor edge to edge - including behind the taskbar - and the cursor can
 * hover a card anywhere on screen.
 *
 * We deliberately size to a single display rather than the union of all monitors:
 * a window spanning displays with different DPI scale factors is mis-sized by
 * Electron (the DIP<->physical conversion picks one display's scale for the whole
 * window). True all-monitor coverage needs one window per display - a follow-up.
 */
function computeHudBounds(owner: BrowserWindow | null): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const display = owner ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay();
	return display.bounds;
}

/**
 * Create the cadenza HUD window as a child of `parent`, or return the existing
 * one. Sized to cover the parent display's work area; transparent, always-on-top
 * and click-through, so it's invisible and inert until a cadenza renders.
 */
export function ensureCadenzaHudWindow(
	parent: BrowserWindow,
	deps: CadenzaHudWindowDeps
): BrowserWindow {
	const existing = getCadenzaHudWindow();
	if (existing) return existing;

	// Fresh window: nothing is subscribed yet, so buffer until it signals ready,
	// and reset hover state (no rects reported, click-through until proven over).
	hudReady = false;
	pendingPayloads = [];
	cardRects = [];
	lastInteractive = false;
	ensureHudListeners();

	// Cover the full monitor Maestro is on (bounds, not work area) so cards float
	// and are hoverable edge to edge.
	const { x, y, width, height } = computeHudBounds(parent);

	const win = new BrowserWindow({
		x,
		y,
		width,
		height,
		// Intentionally NO `parent`: an OS-owned window activates its owner when
		// clicked (Windows), stealing foreground from the app beneath. See
		// `ownerWindow`. Lifecycle is managed manually instead.
		transparent: true,
		frame: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		// Non-activating: cards still receive mouse clicks (drag, buttons), but
		// clicking the HUD never transfers activation to it, so the app the user is
		// working in keeps focus. The HUD must stay a passive overlay.
		focusable: false,
		// Shown inactive so the HUD never steals focus from the app the user is in.
		show: false,
		webPreferences: {
			preload: deps.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	hudWindow = win;
	ownerWindow = parent;
	// Track the HUD in the registry as a `cadenza-hud` kind. The multi-window
	// machinery (persistence, "Move to Window", auto-close, telemetry) skips this
	// kind; registering it just keeps window tracking uniform + gives the close
	// path a single deregistration point.
	hudWindowId = deps.windowRegistry.create({
		browserWindow: win,
		kind: 'cadenza-hud',
		isMain: false,
		sessionIds: [],
	});

	// The constructor clamps width/height to ~a single display's default size on
	// Windows, so a full-monitor window (esp. a hi-DPI one) comes out too small.
	// Re-assert the true monitor bounds via setBounds, which is not clamped.
	win.setBounds(computeHudBounds(parent));

	// Float above other applications, not merely above the parent window.
	win.setAlwaysOnTop(true, 'screen-saver');
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

	// Click-through by default (see file header). The main-process hover poll
	// flips this off while the cursor is over a card.
	win.setIgnoreMouseEvents(true);

	const url = deps.isDevelopment
		? withHudFlag(deps.devServerUrl)
		: withHudFlag(deps.rendererProductionUrl);
	win.loadURL(url);

	win.once('ready-to-show', () => {
		if (!win.isDestroyed()) win.showInactive();
	});

	win.on('closed', () => {
		if (hudWindow === win) {
			// Deregister from the window registry (it has no auto-teardown), then
			// reset the HUD's own feature state - notably clearing the hover-poll
			// interval, which nothing else will do for us.
			if (hudWindowId) {
				deps.windowRegistry.remove(hudWindowId);
				hudWindowId = null;
			}
			hudWindow = null;
			ownerWindow = null;
			hudReady = false;
			pendingPayloads = [];
			cardRects = [];
			lastInteractive = false;
			if (hoverPoll) {
				clearInterval(hoverPoll);
				hoverPoll = null;
			}
		}
	});

	// The HUD only ever shows its own bundle: deny popups and navigation away.
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

	logger.info('Cadenza HUD window created', 'CadenzaHud', {
		display: `${width}x${height}`,
		mode: deps.isDevelopment ? 'development' : 'production',
	});

	return win;
}

/**
 * Route a cadenza payload to the HUD window, creating it lazily. Buffers the
 * payload if the renderer hasn't subscribed yet (see `hudReady`). Returns false
 * only if the window can't be created (no parent), so callers can fall back to
 * the in-app renderer.
 */
export function deliverCadenzaToHud(
	parent: BrowserWindow,
	deps: CadenzaHudWindowDeps,
	payload: CadenzaPayload
): boolean {
	const win = ensureCadenzaHudWindow(parent, deps);
	if (win.isDestroyed()) return false;
	if (hudReady) {
		win.webContents.send('remote:cadenza', payload);
	} else {
		pendingPayloads.push(payload);
	}
	return true;
}

/** Close the cadenza HUD window if it's open. The `'closed'` handler owns all
 *  teardown (nulling refs, clearing the hover-poll interval, resetting state);
 *  nulling `hudWindow` here would make its `hudWindow === win` guard fail and
 *  leak the interval. */
export function closeCadenzaHudWindow(): void {
	const win = getCadenzaHudWindow();
	if (win) win.close();
}
