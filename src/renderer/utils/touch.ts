/**
 * Touch primitives for the desktop renderer running on phones (web-desktop build).
 *
 * Hoisted from `src/web/mobile/constants.ts` so the desktop renderer can share
 * one canonical source of haptic feedback, gesture thresholds, and touch-target
 * sizing instead of re-deriving them. The legacy mobile app under `src/web/`
 * still imports its own copy; retirement of the duplicate is tracked for a later
 * phase. Prefer these helpers over hand-rolling `navigator.vibrate` calls or
 * pointer-media queries.
 */

/**
 * Minimum touch target size per Apple HIG guidelines (44pt).
 * Use this constant for all interactive elements to ensure accessibility.
 */
export const MIN_TOUCH_TARGET = 44;

/**
 * Touch gesture detection thresholds shared across touch interactions.
 */
export const GESTURE_THRESHOLDS = {
	/** Minimum distance (px) for swipe detection */
	swipeDistance: 50,
	/** Maximum time (ms) for swipe gesture */
	swipeTime: 300,
	/** Distance (px) for pull-to-refresh trigger */
	pullToRefresh: 80,
	/** Long press duration (ms) */
	longPress: 500,
	/** Max touch travel (px, per-axis) still counted as a tap rather than a scroll/drag */
	tapMoveTolerance: 10,
} as const;

/** A point in client coordinates, as read from a Touch (clientX/clientY). */
export interface TouchPoint {
	x: number;
	y: number;
}

/**
 * True when a touch moved little enough (within `tolerance` on both axes) between
 * `start` and `end` to count as a tap rather than a scroll or drag. Lets callers
 * decide tap-only affordances (summon the keyboard, activate a control) from raw
 * touch coordinates without wiring up a full gesture hook. Defaults to
 * `GESTURE_THRESHOLDS.tapMoveTolerance`.
 */
export function isTapGesture(
	start: TouchPoint,
	end: TouchPoint,
	tolerance: number = GESTURE_THRESHOLDS.tapMoveTolerance
): boolean {
	return Math.abs(end.x - start.x) <= tolerance && Math.abs(end.y - start.y) <= tolerance;
}

/**
 * Haptic patterns for different interactions.
 * Values are `navigator.vibrate` patterns (ms, or on/off pattern arrays).
 */
export const HAPTIC_PATTERNS = {
	/** Light tap for button presses */
	tap: 10,
	/** Medium feedback for sends */
	send: [10, 30, 10],
	/** Strong feedback for interrupts */
	interrupt: [50, 30, 50],
	/** Success pattern */
	success: [10, 50, 20],
	/** Error pattern */
	error: [100, 30, 100, 30, 100],
} as const;

/**
 * Check if the device supports haptic feedback.
 */
export function supportsHaptics(): boolean {
	if (typeof window === 'undefined') return false;
	return typeof navigator.vibrate === 'function';
}

/**
 * Trigger haptic feedback (if supported).
 * @param pattern - Vibration pattern in milliseconds
 */
export function triggerHaptic(pattern: number | readonly number[] = 10): void {
	if (supportsHaptics()) {
		navigator.vibrate(pattern as VibratePattern);
	}
}

/**
 * True when the primary pointer is coarse (finger / stylus) rather than a mouse.
 *
 * Used to gate touch-only affordances (long-press menus, tap-to-open overlays,
 * always-visible row actions) so mouse and keyboard behavior stays unchanged.
 * Falls back to `false` if `matchMedia` is unavailable or throws.
 */
export function isCoarsePointer(): boolean {
	try {
		return window.matchMedia('(pointer: coarse)').matches;
	} catch {
		return false;
	}
}

/** `pointerType` of the most recent pointer to enter or press anything, or null before the first. */
let lastPointerType: string | null = null;
let pointerTypeTrackingInstalled = false;

/** Module-scoped so a second `addEventListener` with it is deduped by the DOM. */
function recordPointerType(e: PointerEvent): void {
	lastPointerType = e.pointerType || null;
}

/**
 * Start recording which kind of pointer is driving the page. Idempotent, and
 * a no-op outside a browser. Listens at capture on `document`, so it sees the
 * pointer event before any element handler sees the mouse event that follows.
 */
export function installPointerTypeTracking(): void {
	if (pointerTypeTrackingInstalled || typeof document === 'undefined') return;
	pointerTypeTrackingInstalled = true;
	document.addEventListener('pointerover', recordPointerType, { capture: true, passive: true });
	document.addEventListener('pointerdown', recordPointerType, { capture: true, passive: true });
}

/**
 * True when the mouse event being handled right now was emulated from a touch
 * rather than produced by a real mouse.
 *
 * iOS answers every tap with the compatibility sequence mouseover -> mouseenter
 * -> mousedown -> click, and never follows it with a mouseleave. A hover
 * affordance wired to `mouseenter` therefore arms on every tap and then stays
 * up, because nothing ever tells it the "hover" ended. Pointer events fire
 * BEFORE their compatibility mouse events, so the pointer type recorded by
 * `installPointerTypeTracking` describes the mouse event currently being
 * dispatched. Asking the primary pointer instead (`isCoarsePointer`) would be
 * wrong on a hybrid device: an iPad with a trackpad, or a touchscreen laptop,
 * has both, and each event has to be judged by the pointer that produced it.
 *
 * Before any pointer event has been seen (tracking not installed, or a browser
 * without Pointer Events) this falls back to the primary pointer.
 */
export function isTouchEmulatedMouseEvent(): boolean {
	if (lastPointerType === null) return isCoarsePointer();
	return lastPointerType === 'touch' || lastPointerType === 'pen';
}

/** Test-only: forget the recorded pointer type and listener state. */
export function resetPointerTypeTrackingForTests(): void {
	lastPointerType = null;
	pointerTypeTrackingInstalled = false;
}
