/**
 * Message-by-message scroll navigation for chat-like scroll containers.
 *
 * Shared between TerminalOutput (1-1 AI chat) and GroupChatMessages (group chat).
 * Each message is a direct DOM element marked with a data attribute
 * (`data-log-index` or `data-message-timestamp`); these helpers find the next
 * message edge above or below the current scroll position and align its top
 * with the container top.
 */

// Tolerance band (px) for treating a message as "at the top" of the viewport.
// Anything within this distance of the container top is considered current.
const EDGE_TOLERANCE_PX = 4;

/**
 * Jump scroll to the next message boundary in the given direction.
 *
 * - `'up'`: scroll up to the most recent message whose top is above the viewport.
 * - `'down'`: scroll down to the next message whose top is below the viewport top.
 *
 * Returns true if a target was found and scrolled to.
 */
export function jumpToMessageEdge(
	container: HTMLElement,
	selector: string,
	direction: 'up' | 'down'
): boolean {
	const messages = container.querySelectorAll<HTMLElement>(selector);
	if (messages.length === 0) return false;

	const containerTop = container.getBoundingClientRect().top;

	let target: HTMLElement | undefined;
	if (direction === 'up') {
		for (let i = messages.length - 1; i >= 0; i--) {
			const delta = messages[i].getBoundingClientRect().top - containerTop;
			if (delta < -EDGE_TOLERANCE_PX) {
				target = messages[i];
				break;
			}
		}
	} else {
		for (const m of messages) {
			const delta = m.getBoundingClientRect().top - containerTop;
			if (delta > EDGE_TOLERANCE_PX) {
				target = m;
				break;
			}
		}
	}

	if (!target) return false;
	scrollMessageToTop(container, target);
	return true;
}

/** Align the top of `messageEl` with the top of `container`. */
export function scrollMessageToTop(container: HTMLElement, messageEl: HTMLElement): void {
	const containerTop = container.getBoundingClientRect().top;
	const messageTop = messageEl.getBoundingClientRect().top;
	container.scrollTop += messageTop - containerTop;
}

/**
 * True when an arrow-key event originated from a text-editing element (input,
 * textarea, or contenteditable). Used to avoid intercepting arrow keys when
 * the user is typing.
 */
export function isTextInputTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
	if (target.isContentEditable) return true;
	return false;
}

/** `<input>` types that swallow typed characters. Everything else (range,
 *  color, checkbox, radio, button) reacts to keys but never accepts text. */
const TEXT_ENTRY_INPUT_TYPES = new Set([
	'text',
	'search',
	'url',
	'email',
	'password',
	'number',
	'tel',
	'date',
	'datetime-local',
	'month',
	'time',
	'week',
]);

/**
 * True when the target accepts free-form typed text, so a keystroke belongs to
 * it rather than to a surface-level shortcut.
 *
 * Narrower than {@link isTextInputTarget}, which counts every `<input>`. Use
 * that one for arrow keys, where a range slider legitimately owns Left/Right.
 * Use this one for shortcuts a slider has no claim on (Cmd+Z, single-letter
 * tool keys): a focused slider must not silently disable them.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.tagName === 'TEXTAREA') return true;
	if (target.tagName !== 'INPUT') return false;
	// A bare <input> with no type attribute is a text field.
	const type = (target as HTMLInputElement).type?.toLowerCase() || 'text';
	return TEXT_ENTRY_INPUT_TYPES.has(type);
}
