/**
 * "Is the caret in a text field right now?"
 *
 * A keyboard shortcut that calls `preventDefault()` takes the key away from
 * whatever the user is typing into. For chords the OS already owns inside a
 * text field - `Cmd+Left`/`Cmd+Right` are beginning/end-of-line on macOS,
 * `Cmd+A` is select-all - claiming the key while an input has focus breaks
 * editing in a way that reads as the app randomly misbehaving.
 *
 * This is a FOCUS question and nothing else. It is deliberately separate from
 * questions like "is this file editable", which are properties of the DOCUMENT
 * and are decided once when the file loads. Confusing the two is what let the
 * file preview walk its breadcrumb history while the caret sat in the find bar:
 * the guard there tested a file-type flag and never looked at focus.
 */

/** Whether the event target is a control that owns raw keyboard input. */
export function isEditingTextTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

/**
 * Same question asked of whatever currently holds focus, for handlers bound to
 * `window`/`document` where the event target is the body rather than the field.
 */
export function isEditingTextFocused(doc: Document = document): boolean {
	return isEditingTextTarget(doc.activeElement);
}
