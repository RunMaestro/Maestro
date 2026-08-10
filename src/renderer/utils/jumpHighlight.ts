/**
 * Scroll a jump target into view and flash it so the user sees where they
 * landed. Shared by Settings search (jump to a setting) and cross-tab message
 * search (jump to a message in another tab).
 *
 * The retry loop matters: callers typically switch a tab or panel in the same
 * turn, so the target often isn't laid out yet on the first frame. Polling with
 * rAF until the element exists AND has an offsetParent avoids the classic
 * failure where scrollIntoView silently no-ops against a `display: none`
 * ancestor.
 *
 * Durations here must stay in sync with the `.jump-flash` animations in
 * index.css.
 */

/** Matches the `.jump-flash` / `.jump-flash--arrow` animation length in index.css. */
export const JUMP_FLASH_DURATION_MS = 3000;

/** ~500ms at 60fps - enough for a tab switch plus lazy content to render. */
const DEFAULT_MAX_ATTEMPTS = 30;

export interface FlashJumpTargetOptions {
	/** Themed flash color (CSS color string). Defaults to the indigo fallback. */
	color?: string;
	/** Render the pointing arrow in the left margin. Default false. */
	arrow?: boolean;
	/** Scroll alignment, or false to skip scrolling entirely. Default 'center'. */
	block?: ScrollLogicalPosition | false;
	behavior?: ScrollBehavior;
	/**
	 * Re-assert the scroll position for this many animation frames after the
	 * initial scroll. Default 0 (scroll once).
	 *
	 * Needed when the scroll container only estimates the height of off-screen
	 * content - `content-visibility: auto` with `contain-intrinsic-size`, as the
	 * chat transcript uses. The first scroll lands against those estimates, and
	 * the target then drifts as rows near the viewport report their real
	 * heights. Re-scrolling is a no-op once nothing is moving.
	 */
	stabilizeFrames?: number;
}

/**
 * Apply the flash to an element that is already on screen.
 * Returns a cleanup that removes the highlight early.
 */
export function flashJumpTarget(el: HTMLElement, options: FlashJumpTargetOptions = {}): () => void {
	const {
		color,
		arrow = false,
		block = 'center',
		behavior = 'smooth',
		stabilizeFrames = 0,
	} = options;

	let done = false;
	let stabilizeRaf: number | null = null;

	if (block !== false) {
		el.scrollIntoView({ behavior, block });
		if (stabilizeFrames > 0) {
			let framesLeft = stabilizeFrames;
			const restabilize = () => {
				stabilizeRaf = null;
				if (done) return;
				// Always instant here: an animated correction would still be in
				// flight when the next frame issues the one after it.
				el.scrollIntoView({ behavior: 'auto', block });
				if (--framesLeft > 0) stabilizeRaf = requestAnimationFrame(restabilize);
			};
			stabilizeRaf = requestAnimationFrame(restabilize);
		}
	}

	if (color) el.style.setProperty('--jump-flash-color', color);
	el.classList.add('jump-flash');
	if (arrow) el.classList.add('jump-flash--arrow');

	const clear = () => {
		if (done) return;
		done = true;
		if (stabilizeRaf !== null) {
			cancelAnimationFrame(stabilizeRaf);
			stabilizeRaf = null;
		}
		el.classList.remove('jump-flash', 'jump-flash--arrow');
		el.style.removeProperty('--jump-flash-color');
	};
	const timer = setTimeout(clear, JUMP_FLASH_DURATION_MS);
	return () => {
		clearTimeout(timer);
		clear();
	};
}

export interface JumpToElementOptions extends FlashJumpTargetOptions {
	/** How many animation frames to keep looking for the element. */
	maxAttempts?: number;
	/**
	 * Require the element to be laid out (offsetParent !== null) before acting.
	 * Turn off for `position: fixed` targets, which always report a null
	 * offsetParent. Default true.
	 */
	requireVisible?: boolean;
	/** Called once the target was found and flashed. */
	onFound?: (el: HTMLElement) => void;
	/** Called if the element never showed up within `maxAttempts`. */
	onTimeout?: () => void;
}

/**
 * Wait for a jump target to appear, then scroll to it and flash it.
 * Returns a cancel function that aborts the wait and clears any active flash.
 */
export function jumpToElement(
	resolve: () => HTMLElement | null | undefined,
	options: JumpToElementOptions = {}
): () => void {
	const {
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		requireVisible = true,
		onFound,
		onTimeout,
		...flashOptions
	} = options;

	let cancelled = false;
	let attempts = 0;
	let clearFlash: (() => void) | null = null;

	const tick = () => {
		if (cancelled) return;
		const el = resolve();
		if (el && (!requireVisible || el.offsetParent !== null)) {
			clearFlash = flashJumpTarget(el, flashOptions);
			onFound?.(el);
			return;
		}
		if (attempts++ < maxAttempts) {
			requestAnimationFrame(tick);
		} else {
			onTimeout?.();
		}
	};
	requestAnimationFrame(tick);

	return () => {
		cancelled = true;
		clearFlash?.();
	};
}
