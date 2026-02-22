/**
 * Shared activity event bus.
 *
 * Multiple hooks (useActivityTracker, useHandsOnTimeTracker, useGitStatusPolling)
 * each registered their own keydown/mousedown/wheel/touchstart listeners — totaling
 * 13+ global event listeners all doing the same thing: detecting user activity.
 *
 * This module consolidates them into a single set of passive listeners.
 * Hooks subscribe via `subscribeToActivity()` and receive a callback when any
 * user interaction occurs.
 *
 * Passive listeners are used because none of the activity trackers call
 * preventDefault(), so the browser can handle scroll/touch without waiting for JS.
 */

type ActivityCallback = () => void;

const callbacks = new Set<ActivityCallback>();
let listenersAttached = false;

function handleActivity() {
	for (const cb of callbacks) {
		cb();
	}
}

function attachListeners() {
	if (listenersAttached) return;
	window.addEventListener('keydown', handleActivity, { passive: true });
	window.addEventListener('mousedown', handleActivity, { passive: true });
	window.addEventListener('wheel', handleActivity, { passive: true });
	window.addEventListener('touchstart', handleActivity, { passive: true });
	window.addEventListener('click', handleActivity, { passive: true });
	listenersAttached = true;
}

function detachListeners() {
	if (!listenersAttached) return;
	window.removeEventListener('keydown', handleActivity);
	window.removeEventListener('mousedown', handleActivity);
	window.removeEventListener('wheel', handleActivity);
	window.removeEventListener('touchstart', handleActivity);
	window.removeEventListener('click', handleActivity);
	listenersAttached = false;
}

/**
 * Subscribe to user activity events.
 * Returns an unsubscribe function.
 *
 * Listeners are lazily attached when the first subscriber joins
 * and cleaned up when the last subscriber leaves.
 */
export function subscribeToActivity(callback: ActivityCallback): () => void {
	callbacks.add(callback);
	if (callbacks.size === 1) {
		attachListeners();
	}
	return () => {
		callbacks.delete(callback);
		if (callbacks.size === 0) {
			detachListeners();
		}
	};
}
