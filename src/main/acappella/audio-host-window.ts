/**
 * A Cappella audio host window - the main process's audio I/O device.
 *
 * Electron's main process has no `AudioContext`, no `getUserMedia`, and no
 * `AudioWorklet`: everything that touches a microphone or a speaker has to run
 * in a renderer. So A Cappella gets one hidden renderer whose entire job is
 * audio. It loads the ordinary Maestro renderer bundle with `?acappellaAudio`,
 * which boots into the audio host root instead of the app (see
 * `src/renderer/main.tsx`), captures the mic through Chromium's own libwebrtc
 * audio processing module (AEC, noise suppression, auto gain), and plays TTS
 * back out through the same context so the echo canceller has a real reference
 * signal to subtract. No native modules, and the identical capture path will
 * terminate the phone's peer connection in Phase 10.
 *
 * Properties this module is responsible for:
 *
 * - **Invisible, and invisible everywhere.** `show: false` and never shown, so
 *   it cannot be raised, cycled to, or moved. It registers as an
 *   `acappella-audio` kind in the {@link WindowRegistry}, which every
 *   multi-window consumer (persistence, "Move to Window", empty-window
 *   auto-close, telemetry) filters out by asking for `getAppWindows()`.
 *   `skipTaskbar` keeps it off the Windows/Linux taskbar and
 *   `setExcludedFromShownWindowsMenu` off the macOS Window menu.
 * - **Never throttled.** A hidden, never-painted window is exactly what
 *   Chromium's background throttling targets, and a throttled timer in the
 *   audio path is a dropout. `backgroundThrottling: false` opts out.
 * - **Lazily created, eagerly destroyed.** Built on the first session start
 *   ({@link ensureAcappellaAudioHostWindow}) rather than at boot, and torn down
 *   when the Encore Feature is switched off or the app quits, so a user who
 *   never speaks never pays for a second renderer or an open microphone.
 *
 * Deliberately NOT offscreen-rendered (`webPreferences.offscreen`): OSR exists
 * to get pixels out of a window, and this window has no pixels anyone wants. It
 * would add a frame pipeline and lose the GPU compositor for zero benefit.
 * `paintWhenInitiallyHidden: false` is the cheaper answer - the window never
 * paints at all, while its JS, its `AudioContext`, and its worklet run normally.
 */

import { BrowserWindow, type WebContents } from 'electron';

import { isMacOS } from '../../shared/platformDetection';
import { logger } from '../utils/logger';
import type { WindowRegistry } from '../window-registry';

const LOG_CONTEXT = 'ACappellaAudio';

/**
 * Everything the audio host needs to load the renderer bundle. Same shape as
 * `CadenzaHudWindowDeps` on purpose: both are host-owned feature windows that
 * reuse the main preload plus the main bundle with a boot-mode query.
 */
export interface AudioHostWindowDeps {
	isDevelopment: boolean;
	preloadPath: string;
	/** Custom-protocol URL used to load the production renderer. */
	rendererProductionUrl: string;
	/** Development server URL. */
	devServerUrl: string;
	/** Registry the window enrolls in as an `acappella-audio` kind. */
	windowRegistry: WindowRegistry;
}

let audioWindow: BrowserWindow | null = null;
/** Registry id for the audio host, so its `closed` handler can deregister it. */
let audioWindowId: string | null = null;

/** The audio host window, or null when A Cappella has never opened one. */
export function getAcappellaAudioHostWindow(): BrowserWindow | null {
	return audioWindow && !audioWindow.isDestroyed() ? audioWindow : null;
}

/**
 * True when `contents` is the audio host's own web contents.
 *
 * The default session denies every media permission request (see
 * `main-window-navigation.ts`), which is the correct posture for the app window
 * and for embedded browser tabs. Permission handlers are per-session, not
 * per-window, so the microphone grant has to be expressed as "this exact
 * webContents" rather than as a looser session-wide allowance.
 */
export function isAcappellaAudioHostContents(contents: WebContents | null | undefined): boolean {
	const win = getAcappellaAudioHostWindow();
	if (!win || !contents) return false;
	return contents === win.webContents;
}

/** Append the `acappellaAudio` flag so main.tsx boots into audio-host mode. */
function withAudioHostFlag(url: string): string {
	return url.includes('?') ? `${url}&acappellaAudio` : `${url}?acappellaAudio`;
}

/**
 * Create the audio host window, or return the existing one. Called on session
 * start; safe to call repeatedly.
 */
export function ensureAcappellaAudioHostWindow(deps: AudioHostWindowDeps): BrowserWindow {
	const existing = getAcappellaAudioHostWindow();
	if (existing) return existing;

	const win = new BrowserWindow({
		// Small rather than zero-sized: Chromium clamps a 0x0 window anyway, and a
		// sane size keeps devtools usable when debugging the audio path.
		width: 480,
		height: 320,
		show: false,
		// The window is never shown, so nothing here is user-visible; these keep
		// the OS from surfacing it in any window-management affordance.
		frame: false,
		skipTaskbar: true,
		focusable: false,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		hasShadow: false,
		// Never composite a frame for a window nobody sees. `ready-to-show` does
		// not fire when this is false, so load completion is observed through
		// `did-finish-load` instead.
		paintWhenInitiallyHidden: false,
		webPreferences: {
			preload: deps.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// Non-negotiable: Chromium throttles timers in hidden windows, and a
			// throttled audio timer is an audible dropout.
			backgroundThrottling: false,
		},
	});

	audioWindow = win;
	// Tracked as a feature window so teardown and telemetry stay uniform. Every
	// multi-window consumer reads `getAppWindows()`, so this kind is invisible to
	// "Move to Window", the window switcher, persistence, and auto-close.
	audioWindowId = deps.windowRegistry.create({
		browserWindow: win,
		kind: 'acappella-audio',
		isMain: false,
		sessionIds: [],
	});

	// macOS lists every window in the app's Window menu; a hidden audio device is
	// not something the user can meaningfully switch to.
	if (isMacOS()) win.excludedFromShownWindowsMenu = true;

	const url = deps.isDevelopment
		? withAudioHostFlag(deps.devServerUrl)
		: withAudioHostFlag(deps.rendererProductionUrl);
	void win.loadURL(url);

	win.on('closed', () => {
		if (audioWindow !== win) return;
		if (audioWindowId) {
			deps.windowRegistry.remove(audioWindowId);
			audioWindowId = null;
		}
		audioWindow = null;
		logger.info('A Cappella audio host window closed', LOG_CONTEXT);
	});

	// The audio host only ever runs its own bundle: no popups, no navigation.
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	win.webContents.on('will-navigate', (event, target) => {
		if (target !== url) event.preventDefault();
	});

	logger.info('A Cappella audio host window created', LOG_CONTEXT, {
		mode: deps.isDevelopment ? 'development' : 'production',
	});

	return win;
}

/**
 * Destroy the audio host window if it is open. Called when the Encore Feature is
 * switched off and on app quit. The `'closed'` handler owns all teardown, so
 * nothing is nulled here - doing so would make its identity guard fail and leak
 * the registry entry.
 */
export function closeAcappellaAudioHostWindow(): void {
	const win = getAcappellaAudioHostWindow();
	if (win) win.close();
}
