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
 * CSS custom property carrying the height actually visible to the user, on
 * `<html>`.
 *
 * `100dvh` is the *layout* viewport, and on iOS the on-screen keyboard does
 * not shrink it - it slides over the page. A full-screen phone modal sized to
 * `100dvh` therefore keeps its full height while the bottom ~45% of it sits
 * under the keyboard. Both search surfaces autofocus their input on open (the
 * command palette's `autoFocus`, the tab switcher's `useFocusOnMount`), so the
 * keyboard is up from the first frame and the results list is born mostly
 * buried: the user can type to filter, but the rows they are trying to scroll
 * through are behind the keys. That is the "I can filter but I can't scroll
 * the options" report.
 *
 * `visualViewport.height` is the half that does shrink, so publishing it lets
 * the phone rules size a modal to what the user can actually see.
 */
export const VIEWPORT_HEIGHT_PROPERTY = '--maestro-viewport-height';

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
 * The height the user can actually see, in CSS px.
 *
 * `visualViewport.height` when the browser reports one (every iOS Safari that
 * can raise a keyboard does), otherwise `innerHeight`, which is the same
 * number on a platform where the keyboard already shrinks the layout viewport.
 * Rounded DOWN so a fractional height can never exceed the real viewport and
 * push the modal's own footer off the bottom edge.
 */
export function measureVisibleViewportHeight(win: Window): number {
	const visual = win.visualViewport?.height;
	const height = typeof visual === 'number' && visual > 0 ? visual : win.innerHeight;
	return Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;
}

/**
 * Publish the measured inset on `<html>` and keep it current across rotation
 * and viewport changes. Returns a disposer.
 */
export function installStandaloneStatusBarInset(win: Window): () => void {
	const apply = () => {
		const px = measureStandaloneStatusBarInset(sampleStandaloneViewport(win));
		win.document.documentElement.style.setProperty(STATUS_BAR_INSET_PROPERTY, `${px}px`);
		// Republished on the same events: the keyboard opening is a
		// `visualViewport` resize, and it is the event this value exists for.
		const visible = measureVisibleViewportHeight(win);
		if (visible > 0) {
			win.document.documentElement.style.setProperty(VIEWPORT_HEIGHT_PROPERTY, `${visible}px`);
		}
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
