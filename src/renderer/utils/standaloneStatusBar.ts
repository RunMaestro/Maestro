/**
 * Status bar inset for an iOS home-screen web app when WebKit does not report it.
 *
 * A page added to the Home Screen with `apple-mobile-web-app-status-bar-style`
 * set to `black-translucent` runs under the status bar and is expected to clear
 * it with `env(safe-area-inset-top)`. Since iOS 26.1 WebKit sometimes reports
 * that inset as 0 and shortens the viewport by the status bar height instead,
 * while still laying the page out from the top of the screen. The header then
 * sits inside the system's status bar layer, which dims it and swallows taps
 * there, and nothing in CSS can see it (bugs.webkit.org/show_bug.cgi?id=301994,
 * reopened against iOS 26.5 and the iOS 27 beta). In that state the bar height
 * is exactly the height the viewport lost: `screen.height - innerHeight`, in
 * portrait, in a standalone web app. A healthy WebKit reports a difference of
 * 0 and carries the value in `env()`, so the stylesheet combines the two with
 * `max()` into `--maestro-top-inset` (see the standalone block in index.css).
 *
 * `navigator.standalone` is deliberately the only gate. Android PWAs also run
 * in `display-mode: standalone`, but there the page never extends under the
 * status bar and `innerHeight` legitimately excludes it, so measuring the
 * difference would pad the shell for a bar it already clears. Only WebKit on
 * iOS defines `navigator.standalone`.
 *
 * Import-free on purpose: the web-desktop bootstrap calls it before the
 * renderer loads, so the first paint already clears the bar.
 */

export interface StandaloneViewportSample {
	/** `navigator.standalone === true`: an iOS home-screen web app. */
	standalone: boolean;
	screenHeight: number;
	innerHeight: number;
	innerWidth: number;
}

/**
 * Upper bound on a plausible status bar, in CSS px. The tallest iPhone inset
 * is 62pt (Dynamic Island); anything larger is the on-screen keyboard or some
 * other chrome and must not become top padding.
 */
export const MAX_STATUS_BAR_INSET_PX = 80;

/** CSS custom property the measured inset is published under, on `<html>`. */
export const STATUS_BAR_INSET_PROPERTY = '--maestro-status-bar-inset';

/**
 * The status bar height WebKit hid from `env()`, or 0 when there is nothing to
 * correct: not a home-screen web app, landscape (iOS hides the bar there and
 * `screen.height` stays the long edge), a viewport already sized to the
 * screen, or a difference the size of the keyboard.
 */
export function measureStandaloneStatusBarInset(sample: StandaloneViewportSample): number {
	if (!sample.standalone) return 0;
	if (sample.innerHeight < sample.innerWidth) return 0;
	const missing = sample.screenHeight - sample.innerHeight;
	if (!Number.isFinite(missing) || missing <= 0 || missing > MAX_STATUS_BAR_INSET_PX) return 0;
	return Math.round(missing);
}

export function sampleStandaloneViewport(win: Window): StandaloneViewportSample {
	const nav = win.navigator as Navigator & { standalone?: boolean };
	return {
		standalone: nav.standalone === true,
		screenHeight: win.screen.height,
		innerHeight: win.innerHeight,
		innerWidth: win.innerWidth,
	};
}

/**
 * Publish the measured inset on `<html>` and keep it current across rotation
 * and viewport changes. Returns a disposer.
 */
export function installStandaloneStatusBarInset(win: Window): () => void {
	const apply = () => {
		const px = measureStandaloneStatusBarInset(sampleStandaloneViewport(win));
		win.document.documentElement.style.setProperty(STATUS_BAR_INSET_PROPERTY, `${px}px`);
	};
	apply();
	win.addEventListener('resize', apply);
	win.addEventListener('orientationchange', apply);
	win.visualViewport?.addEventListener('resize', apply);
	return () => {
		win.removeEventListener('resize', apply);
		win.removeEventListener('orientationchange', apply);
		win.visualViewport?.removeEventListener('resize', apply);
	};
}
