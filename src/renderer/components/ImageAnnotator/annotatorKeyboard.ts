/**
 * annotatorKeyboard - Shared keydown targeting rules for the image annotator.
 *
 * The annotator is a full-screen overlay that does NOT move focus away from
 * whatever opened it (the composer textarea, a lightbox, the command palette).
 * Its canvas also calls `preventDefault()` on pointerdown to own the gesture,
 * which suppresses the compatibility mousedown that would normally blur that
 * element - so drawing never shifts focus either.
 *
 * The consequence: a keydown while the annotator is open can still be targeted
 * at a text field that lives UNDERNEATH the overlay. A naive "ignore keys aimed
 * at a form control" guard then silently kills Cmd+Z (and worse, lets the
 * browser undo the user's chat message instead). So the guard has to be scoped:
 * only a text field inside the annotator owns the keystroke.
 *
 * `ImageAnnotator` also focuses its root on open, so in practice the target is
 * the overlay itself. This is the belt to that suspenders - the failure mode is
 * silent and destroys work the user typed elsewhere.
 */

import { isTextEntryTarget, isTextInputTarget } from '../../utils/messageScrollNavigation';

/** Marks the annotator's root element so a keydown target can be scoped to it. */
export const ANNOTATOR_ROOT_ATTR = 'data-image-annotator-root';

function isInsideAnnotator(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return target.closest(`[${ANNOTATOR_ROOT_ATTR}]`) !== null;
}

/**
 * True when the annotator should leave a keydown alone because the user is
 * typing into one of its OWN text fields (a text label, a drawer input).
 *
 * Text fields outside the annotator return false: they are covered by the
 * overlay and only hold focus because nothing took it from them.
 */
export function isAnnotatorTextEntry(target: EventTarget | null): boolean {
	return isTextEntryTarget(target) && isInsideAnnotator(target);
}

/**
 * True when a keydown belongs to one of the annotator's OWN form controls -
 * including the drawer's range sliders, which own Left/Right natively.
 *
 * Use this for arrow keys; use {@link isAnnotatorTextEntry} for shortcuts a
 * slider has no claim on.
 */
export function isAnnotatorFormControl(target: EventTarget | null): boolean {
	if (!isInsideAnnotator(target)) return false;
	if (isTextInputTarget(target)) return true;
	return target instanceof HTMLElement && target.tagName === 'SELECT';
}
