/**
 * Pause decorative looping animations while nobody is looking at the window.
 *
 * Any running CSS animation keeps Chromium producing a frame every vsync, and
 * every one of those frames costs the renderer main thread (style, prepaint,
 * compositing inputs), the compositor, and the GPU process. A Nov 2026 field
 * trace of an idle window with six busy agents measured 4,977 frames in 45
 * seconds (~110/s at 120 Hz) while JS was idle 94.7% of the time.
 *
 * Chromium already stops producing frames for a hidden document. It does NOT
 * stop for a window that is visible but unfocused, which is where Maestro sits
 * most of the time agents work: behind the app the user switched to. This sets
 * one class on `<html>` for that case, and `index.css` maps it to
 * `animation-play-state: paused` on the looping (decorative) animations only.
 * Entrance animations are left alone, so a toast or modal that opens while the
 * window is unfocused still finishes its fade-in.
 *
 * Installed for the main app windows only. Floating widgets (the Throughput
 * Gauge, the media player) exist to be watched while another app has focus.
 */

/** The class on `<html>` that pauses looping animations. */
export const MOTION_PAUSED_CLASS = 'motion-paused';

/**
 * Whether looping animations should be paused right now.
 *
 * `document.hasFocus()` stays true while focus is inside a frame this window
 * hosts (an `<iframe>`, a browser tab's `<webview>`), so using a Maestro
 * browser tab does not freeze the busy indicators beside it.
 */
export function shouldPauseMotion(doc: Document): boolean {
	return doc.visibilityState === 'hidden' || !doc.hasFocus();
}

/**
 * Keep {@link MOTION_PAUSED_CLASS} in step with the window's focus and
 * visibility. Returns a disposer.
 */
export function installMotionPause(win: Window): () => void {
	const doc = win.document;
	const root = doc.documentElement;
	let pending: ReturnType<typeof setTimeout> | null = null;

	const apply = () => {
		pending = null;
		root.classList.toggle(MOTION_PAUSED_CLASS, shouldPauseMotion(doc));
	};
	// Deferred one task: the window `blur` that fires when focus moves into a
	// child frame arrives before the move settles, and `hasFocus()` read inside
	// the handler can still say false.
	const schedule = () => {
		if (pending === null) pending = setTimeout(apply, 0);
	};

	apply();
	win.addEventListener('focus', schedule);
	win.addEventListener('blur', schedule);
	doc.addEventListener('visibilitychange', schedule);
	return () => {
		if (pending !== null) clearTimeout(pending);
		win.removeEventListener('focus', schedule);
		win.removeEventListener('blur', schedule);
		doc.removeEventListener('visibilitychange', schedule);
		root.classList.remove(MOTION_PAUSED_CLASS);
	};
}
