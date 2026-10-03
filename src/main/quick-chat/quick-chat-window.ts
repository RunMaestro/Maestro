/**
 * Quick Chat window - a small, frameless, always-on-top window summoned by a
 * system-wide hotkey. It reuses the main renderer bundle loaded with
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
 */

import { BrowserWindow, screen } from 'electron';
import { isMacOS } from '../../shared/platformDetection';
import type { QuickChatLayout } from '../../shared/quickChat';
import { logger } from '../utils/logger';
import type { WindowRegistry } from '../window-registry';

export interface QuickChatWindowDeps {
	isDevelopment: boolean;
	preloadPath: string;
	/** Custom-protocol URL used to load the production renderer. */
	rendererProductionUrl: string;
	/** Development server URL. */
	devServerUrl: string;
	windowRegistry: WindowRegistry;
}

const WIDTH = 560;
/** Composer only. */
const COMPACT_HEIGHT = 148;
/** Composer plus conversation. */
const EXPANDED_HEIGHT = 600;
/** The window's top edge sits this far down the work area on first show. */
const TOP_OFFSET_RATIO = 0.2;

let quickWindow: BrowserWindow | null = null;
let quickWindowId: string | null = null;
let layout: QuickChatLayout = 'compact';
/** Set once the user drags the window, so later shows keep their spot. */
let userPlaced = false;

/** The Quick Chat window, or null when it has not been created (or was closed). */
export function getQuickChatWindow(): BrowserWindow | null {
	return quickWindow && !quickWindow.isDestroyed() ? quickWindow : null;
}

/** Whether the Quick Chat window is on screen right now. */
export function isQuickChatWindowVisible(): boolean {
	return getQuickChatWindow()?.isVisible() ?? false;
}

function heightFor(next: QuickChatLayout): number {
	return next === 'expanded' ? EXPANDED_HEIGHT : COMPACT_HEIGHT;
}

/** Centered on the display under the cursor, near the top of its work area. */
function defaultBounds(height: number): Electron.Rectangle {
	const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	const area = display.workArea;
	return {
		x: Math.round(area.x + (area.width - WIDTH) / 2),
		y: Math.round(area.y + area.height * TOP_OFFSET_RATIO),
		width: WIDTH,
		height,
	};
}

function withQuickChatFlag(url: string): string {
	return url.includes('?') ? `${url}&quickChat` : `${url}?quickChat`;
}

function createQuickChatWindow(deps: QuickChatWindowDeps): BrowserWindow {
	const win = new BrowserWindow({
		...defaultBounds(heightFor(layout)),
		// Non-activating floating panel on macOS (see file header).
		...(isMacOS() ? { type: 'panel' } : {}),
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: true,
		resizable: false,
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

	win.setAlwaysOnTop(true, 'floating');
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

	const url = withQuickChatFlag(
		deps.isDevelopment ? deps.devServerUrl : deps.rendererProductionUrl
	);
	win.loadURL(url);

	// `will-move` fires only for a move the user makes, never for setBounds.
	win.on('will-move', () => {
		userPlaced = true;
	});

	win.on('closed', () => {
		if (quickWindow !== win) return;
		if (quickWindowId) {
			deps.windowRegistry.remove(quickWindowId);
			quickWindowId = null;
		}
		quickWindow = null;
		userPlaced = false;
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

/** Show and focus the window, creating it on first use. */
export function showQuickChatWindow(deps: QuickChatWindowDeps): BrowserWindow {
	const existing = getQuickChatWindow();
	const win = existing ?? createQuickChatWindow(deps);
	if (!userPlaced) win.setBounds(defaultBounds(heightFor(layout)));
	const reveal = () => {
		if (win.isDestroyed()) return;
		win.show();
		win.focus();
		win.webContents.send('quickChat:focusInput');
	};
	// A fresh window paints its first frame later; showing it before then
	// flashes an empty transparent rectangle.
	if (existing) reveal();
	else win.once('ready-to-show', reveal);
	return win;
}

export function hideQuickChatWindow(): void {
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

/** Grow to show the conversation, or shrink back to the composer, keeping the top edge. */
export function setQuickChatLayout(next: QuickChatLayout): void {
	layout = next;
	const win = getQuickChatWindow();
	if (!win) return;
	const bounds = win.getBounds();
	const height = heightFor(next);
	if (bounds.height === height) return;
	win.setBounds({ ...bounds, height });
}

/** Destroy the window outright (feature switched off, primary window closing). */
export function closeQuickChatWindow(): void {
	getQuickChatWindow()?.close();
}
