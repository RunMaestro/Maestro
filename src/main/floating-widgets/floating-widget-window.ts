/**
 * Floating widget window - one small, frameless, always-on-top desktop window
 * per widget (the throughput gauge, the media player). It reuses the main
 * renderer bundle loaded with `?floatingWidget=<id>`, which boots into
 * FloatingWidgetRoot (that widget's body only). See `Plans/floating-widgets.md`.
 *
 * Built like Quick Chat's window (src/main/quick-chat/quick-chat-window.ts):
 * created lazily, then only hidden, never closed, except by `close()` (feature
 * switched off, app quit). On macOS it is a `panel`, so it floats over
 * full-screen apps and shows without activating Maestro. Unlike Quick Chat it
 * never takes focus: it appears with `showInactive()` while the user types
 * somewhere else.
 *
 * The user can move and resize it, and both survive a restart through
 * `deps.boundsStore` (the window-state store's `floatingWidgets[id]`).
 */

import { BrowserWindow, screen } from 'electron';
import {
	NO_FLOATING_WIDGET_OVERFLOW,
	planFloatingWidgetOverflow,
	type FloatingWidgetBounds,
	type FloatingWidgetId,
	type FloatingWidgetOverflow,
	type FloatingWidgetSize,
	type FloatingWidgetSpec,
} from '../../shared/floatingWidgets';
import { isMacOS } from '../../shared/platformDetection';
import { debounce } from '../utils/debounce';
import { logger } from '../utils/logger';
import type { WindowRegistry } from '../window-registry';
import { WINDOW_STATE_SAVE_DEBOUNCE_MS } from '../window-state-persistence';
import {
	finiteNumber,
	positiveNumber,
	resolveSavedWindowRect,
	sanitizeSavedBounds,
} from './window-bounds';

/** Where one widget's bounds persist (its entry in the per-device window-state store). */
export interface FloatingWidgetBoundsStore {
	get(): FloatingWidgetBounds | undefined;
	set(bounds: FloatingWidgetBounds): void;
}

export interface FloatingWidgetWindowDeps {
	isDevelopment: boolean;
	preloadPath: string;
	/** Custom-protocol URL used to load the production renderer. */
	rendererProductionUrl: string;
	/** Development server URL. */
	devServerUrl: string;
	windowRegistry: WindowRegistry;
	boundsStore: FloatingWidgetBoundsStore;
	/**
	 * Whether the widget may exist right now. While false, `show()` and
	 * `ensureCreated()` do nothing (an Encore Feature switched off leaves no
	 * window behind). Omitted means always.
	 */
	isEnabled?: () => boolean;
}

export interface FloatingWidgetController {
	readonly id: FloatingWidgetId;
	/** Show the window without focusing it, creating it on first use. */
	show(): void;
	/** Put the window away. It keeps running, so the next show is instant. */
	hide(): void;
	toggle(): void;
	/** On screen, or about to be (a show waiting for a fresh window's first paint). */
	isVisible(): boolean;
	/** Create the window without showing it, so it can take commands. Returns it, or null when disabled. */
	ensureCreated(): BrowserWindow | null;
	/** The live window, or null when it has not been created (or was closed). */
	getWindow(): BrowserWindow | null;
	/** The live window's bounds, without any overflow, or null when there is no window. */
	getBounds(): Electron.Rectangle | null;
	/**
	 * Move or resize the window the way a drag would, and remember it. Fields
	 * that are not usable numbers are ignored; a size below the minimum is raised
	 * to it; a spot off every display is pulled back on screen. Returns the
	 * window's bounds afterwards, or null when there is no window.
	 */
	setBounds(partial: FloatingWidgetBounds): Electron.Rectangle | null;
	/**
	 * Borrow room past the card for content taller than it (see
	 * `FloatingWidgetOverflow`). `need` is how far each side would have to grow;
	 * the window grows on one side only, within the work area, and resolves with
	 * what it granted. A zero need gives the room back. Never saved; dropped on
	 * hide and on reload.
	 */
	setOverflow(need: FloatingWidgetOverflow): FloatingWidgetOverflow;
	/** Whether the widget's renderer has mounted and subscribed (see the relay). */
	isReady(): boolean;
	/** Called by the relay when the window's renderer says it is ready. */
	markReady(): void;
	/** Destroy the window outright (feature switched off, app quit). */
	close(): void;
}

/** Gap between a default-placed widget and the edges of its work area. */
const DEFAULT_MARGIN = 24;
/** How long after the page loads a fresh window waits for its first paint. */
const FIRST_SHOW_FALLBACK_MS = 150;

function withWidgetParam(url: string, id: FloatingWidgetId): string {
	const param = `floatingWidget=${encodeURIComponent(id)}`;
	return url.includes('?') ? `${url}&${param}` : `${url}?${param}`;
}

export function createFloatingWidgetWindow(
	spec: FloatingWidgetSpec,
	deps: FloatingWidgetWindowDeps
): FloatingWidgetController {
	const minSize = spec.minSize;
	let win: BrowserWindow | null = null;
	let registryId: string | null = null;
	/** The remembered size and spot, loaded once from the bounds store. */
	let saved: FloatingWidgetBounds | null = null;
	/** The live window has painted its first frame (or the fallback fired). */
	let painted = false;
	/** A show was asked for while a fresh window has not painted yet. */
	let revealPending = false;
	let ready = false;
	let flushPendingSave: (() => void) | null = null;
	/** Room currently borrowed past the card. Everything saved or reported excludes it. */
	let overflow: FloatingWidgetOverflow = NO_FLOATING_WIDGET_OVERFLOW;

	const enabled = () => deps.isEnabled?.() ?? true;

	const live = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);

	/** The card's rect inside the window's real one. */
	function withoutOverflow(b: Electron.Rectangle): Electron.Rectangle {
		return {
			x: b.x,
			y: b.y + overflow.above,
			width: b.width,
			height: b.height - overflow.above - overflow.below,
		};
	}

	/** The window's real rect around a card rect. */
	function withOverflow(b: Electron.Rectangle): Electron.Rectangle {
		return {
			x: b.x,
			y: b.y - overflow.above,
			width: b.width,
			height: b.height + overflow.above + overflow.below,
		};
	}

	/**
	 * Give the borrowed room back. The card is put back exactly where the user
	 * sees it now, so a drag made while a list was open is kept.
	 */
	function dropOverflow(target: BrowserWindow | null): void {
		if (overflow.above === 0 && overflow.below === 0) return;
		const card = target ? withoutOverflow(target.getBounds()) : null;
		overflow = NO_FLOATING_WIDGET_OVERFLOW;
		if (card && target && !target.isDestroyed()) target.setBounds(card);
	}

	function loadSaved(): FloatingWidgetBounds {
		if (!saved) saved = sanitizeSavedBounds(deps.boundsStore.get());
		return saved;
	}

	/** The saved size, never below the minimum; the default when nothing was saved. */
	function sizeNow(): FloatingWidgetSize {
		const s = loadSaved();
		return {
			width: Math.max(minSize.width, Math.round(s.width ?? spec.defaultSize.width)),
			height: Math.max(minSize.height, Math.round(s.height ?? spec.defaultSize.height)),
		};
	}

	/** Bottom-right of the work area of the display under the cursor. */
	function defaultBounds(size: FloatingWidgetSize): Electron.Rectangle {
		const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
		const width = Math.min(size.width, area.width);
		const height = Math.min(size.height, area.height);
		return {
			x: Math.round(Math.max(area.x, area.x + area.width - width - DEFAULT_MARGIN)),
			y: Math.round(Math.max(area.y, area.y + area.height - height - DEFAULT_MARGIN)),
			width,
			height,
		};
	}

	/** The saved spot when it is still on a connected display, otherwise the default. */
	function openingBounds(): Electron.Rectangle {
		const size = sizeNow();
		return resolveSavedWindowRect(loadSaved(), size) ?? defaultBounds(size);
	}

	/**
	 * Remember where the window is. Takes the bounds as they were when the event
	 * fired: a save flushed during close would otherwise read teardown geometry
	 * nobody chose (Quick Chat saw a 0-wide frame). Anything below the minimum is
	 * that kind of geometry, and is dropped.
	 */
	function recordBounds(b: Electron.Rectangle): void {
		if (b.width < minSize.width || b.height < minSize.height) return;
		const prev = loadSaved();
		if (prev.x === b.x && prev.y === b.y && prev.width === b.width && prev.height === b.height) {
			return;
		}
		saved = { x: b.x, y: b.y, width: b.width, height: b.height };
		deps.boundsStore.set(saved);
	}

	function reveal(target: BrowserWindow): void {
		revealPending = false;
		if (target.isDestroyed()) return;
		target.showInactive();
	}

	function create(): BrowserWindow {
		painted = false;
		ready = false;
		const created = new BrowserWindow({
			...openingBounds(),
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
			minWidth: minSize.width,
			minHeight: minSize.height,
			webPreferences: {
				preload: deps.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});

		win = created;
		registryId = deps.windowRegistry.create({
			browserWindow: created,
			kind: 'floating-widget',
			isMain: false,
			sessionIds: [],
		});

		created.setAlwaysOnTop(true, 'floating');
		created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

		const url = withWidgetParam(
			deps.isDevelopment ? deps.devServerUrl : deps.rendererProductionUrl,
			spec.id
		);
		created.loadURL(url);

		// A fresh window paints its first frame later; showing it before then
		// flashes an empty transparent rectangle. A transparent panel may never
		// emit `ready-to-show` (seen with Quick Chat on macOS), so the page load
		// plus a short wait counts too. Whichever lands first reveals the window,
		// unless a hide arrived in between.
		const onPainted = () => {
			if (painted || created.isDestroyed()) return;
			painted = true;
			if (revealPending) reveal(created);
		};
		created.once('ready-to-show', onPainted);
		created.webContents.once('did-finish-load', () => {
			setTimeout(onPainted, FIRST_SHOW_FALLBACK_MS);
		});

		// A reload or a crashed renderer has to mount and subscribe again before
		// it can take commands.
		// Overflow belongs to the page that asked for it, so a reload gives it back.
		created.webContents.on('did-start-loading', () => {
			ready = false;
			dropOverflow(created);
		});
		created.webContents.on('render-process-gone', () => {
			ready = false;
			dropOverflow(created);
		});

		// Once the window starts closing, its moves and resizes are teardown, not
		// the user, and must not reach the store (see recordBounds).
		let closing = false;
		// A live drag or resize fires a flood of events; save once it settles, and
		// right away when the window is put away or closed so a quit cannot drop it.
		const persist = debounce(recordBounds, WINDOW_STATE_SAVE_DEBOUNCE_MS);
		const capture = () => {
			if (closing || created.isDestroyed()) return;
			persist(withoutOverflow(created.getBounds()));
		};
		created.on('move', capture);
		created.on('resize', capture);
		created.on('hide', () => {
			dropOverflow(created);
			persist.flush();
		});
		created.on('close', () => {
			closing = true;
			persist.flush();
		});
		flushPendingSave = () => persist.flush();

		created.on('closed', () => {
			persist.cancel();
			if (win !== created) return;
			if (registryId) {
				deps.windowRegistry.remove(registryId);
				registryId = null;
			}
			win = null;
			flushPendingSave = null;
			painted = false;
			revealPending = false;
			ready = false;
			overflow = NO_FLOATING_WIDGET_OVERFLOW;
			// The next window reloads the store, so a spot the user chose survives a
			// close (feature toggled off and on) the same way it survives a restart.
			saved = null;
		});

		// The window only ever shows its own bundle: deny popups and navigation away.
		created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		created.webContents.on('will-navigate', (e) => {
			if (e.url !== url) e.preventDefault();
		});

		logger.info('Floating widget window created', 'FloatingWidgets', {
			id: spec.id,
			mode: deps.isDevelopment ? 'development' : 'production',
		});
		return created;
	}

	function ensureCreated(): BrowserWindow | null {
		const existing = live();
		if (existing) return existing;
		if (!enabled()) return null;
		return create();
	}

	function show(): void {
		const target = ensureCreated();
		if (!target) return;
		if (painted) {
			reveal(target);
			return;
		}
		revealPending = true;
	}

	function hide(): void {
		revealPending = false;
		const target = live();
		if (target?.isVisible()) target.hide();
	}

	function isVisible(): boolean {
		const target = live();
		return !!target && (target.isVisible() || revealPending);
	}

	function setBounds(partial: FloatingWidgetBounds): Electron.Rectangle | null {
		flushPendingSave?.();
		const next: FloatingWidgetBounds = { ...loadSaved() };
		const width = positiveNumber(partial?.width);
		const height = positiveNumber(partial?.height);
		if (width !== undefined) next.width = Math.max(minSize.width, Math.round(width));
		if (height !== undefined) next.height = Math.max(minSize.height, Math.round(height));
		const x = finiteNumber(partial?.x);
		const y = finiteNumber(partial?.y);
		// A spot needs both coordinates; half of one is not a place.
		if (x !== undefined && y !== undefined) {
			next.x = Math.round(x);
			next.y = Math.round(y);
		}
		const target = live();
		// A resize of a window never placed keeps it where it is, rather than
		// jumping to the default corner.
		if (target && (next.x === undefined || next.y === undefined)) {
			const current = withoutOverflow(target.getBounds());
			next.x = current.x;
			next.y = current.y;
		}
		saved = next;
		deps.boundsStore.set(next);
		if (!target) return null;
		target.setBounds(withOverflow(openingBounds()));
		return withoutOverflow(target.getBounds());
	}

	function setOverflow(need: FloatingWidgetOverflow): FloatingWidgetOverflow {
		const target = live();
		if (!target) return NO_FLOATING_WIDGET_OVERFLOW;
		const card = withoutOverflow(target.getBounds());
		const area = screen.getDisplayMatching(card).workArea;
		const granted = planFloatingWidgetOverflow(need, {
			above: card.y - area.y,
			below: area.y + area.height - (card.y + card.height),
		});
		if (granted.above === overflow.above && granted.below === overflow.below) return granted;
		// Set before the resize: the move and resize events it fires read it.
		overflow = granted;
		target.setBounds(withOverflow(card));
		return granted;
	}

	return {
		id: spec.id,
		show,
		hide,
		toggle: () => (isVisible() ? hide() : show()),
		isVisible,
		ensureCreated,
		getWindow: live,
		getBounds: () => {
			const target = live();
			return target ? withoutOverflow(target.getBounds()) : null;
		},
		setBounds,
		setOverflow,
		isReady: () => !!live() && ready,
		markReady: () => {
			if (live()) ready = true;
		},
		close: () => live()?.close(),
	};
}
