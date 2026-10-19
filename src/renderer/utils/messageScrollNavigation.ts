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

/**
 * Surfaces that own every keystroke while the caret is inside them, even when
 * the element a keydown lands on is not itself an input.
 *
 * CodeMirror keeps the caret in a contenteditable, but the event can land on
 * the scroller, a gutter, or one of its panel controls; xterm routes typing
 * through a hidden helper textarea and paints everything else as plain divs and
 * canvases. In both, a key is the user typing into a document even when the
 * literal target is a `<div>`, so the only reliable test is an ancestor lookup.
 * `closest()` matches the element itself too, so the editor or terminal root
 * counts alongside its contents.
 *
 * This is the same `.xterm` test `useMainKeyboardHandler` already runs inline
 * for terminal focus recovery. Keeping one spelling of it here is what lets
 * every caller ask the question once.
 */
const TEXT_ENTRY_SURFACE_SELECTOR = '.cm-editor, .xterm';

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
 * it rather than to a surface-level shortcut. Counts text-accepting inputs,
 * textareas, contenteditables, and anything inside a CodeMirror editor or an
 * xterm terminal (see {@link TEXT_ENTRY_SURFACE_SELECTOR}).
 *
 * Narrower than {@link isTextInputTarget}, which counts every `<input>`. Use
 * that one for arrow keys, where a range slider legitimately owns Left/Right.
 * Use this one for shortcuts a slider has no claim on (Cmd+Z, single-letter
 * tool keys): a focused slider must not silently disable them.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
	// Checked first, and against Element rather than HTMLElement, so a keydown
	// anywhere inside an editor or a terminal counts whatever kind of node it
	// happened to hit (an SVG icon in a CodeMirror panel is still the editor).
	if (target instanceof Element && target.closest(TEXT_ENTRY_SURFACE_SELECTOR) !== null) {
		return true;
	}
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.tagName === 'TEXTAREA') return true;
	if (target.tagName !== 'INPUT') return false;
	// A bare <input> with no type attribute is a text field.
	const type = (target as HTMLInputElement).type?.toLowerCase() || 'text';
	return TEXT_ENTRY_INPUT_TYPES.has(type);
}

/**
 * True when a keystroke is free for an app-level binding to claim: nothing that
 * accepts typed text holds it, so a bare `j` or a `g g` sequence is a command
 * rather than a character.
 *
 * This is the whole definition of Vim "normal mode" in Maestro, and there is
 * deliberately NO mode state machine behind it. A boolean flag would need an
 * enter and an exit for every path focus can take - clicking the composer, a
 * modal autofocusing its first input, CodeMirror mounting, xterm taking focus
 * back after a tab switch, a window blur - and the first path anyone forgot
 * would leave the flag reading "normal" while the user typed prose, so the
 * keyboard would eat their characters with nothing on screen to explain why.
 * Focus already IS that state and the DOM already tracks it correctly, so this
 * asks the DOM and cannot desync from it.
 *
 * Both the event target AND `document.activeElement` have to be free, because
 * they disagree in both directions: a handler bound to `window` sees `<body>`
 * as the target when focus sits on the body, and the image annotator leaves a
 * composer textarea focused underneath its own overlay (see
 * `annotatorKeyboard.ts`). Requiring both is the conservative side of that
 * asymmetry - a wrongly rejected keystroke costs one Vim motion, while a
 * wrongly accepted one steals a character out of something the user is writing.
 *
 * Focus is only half of normal mode. The other half, "no modal layer is open",
 * lives in the layer stack, which is React context rather than DOM, so it stays
 * with the caller: `useMainKeyboardHandler` checks `ctx.hasOpenLayers()` beside
 * this before it feeds an event to the sequence matcher.
 */
export function isNormalMode(
	event: { readonly target: EventTarget | null },
	doc: Document = document
): boolean {
	return !isTextEntryTarget(event.target) && !isTextEntryTarget(doc.activeElement);
}
