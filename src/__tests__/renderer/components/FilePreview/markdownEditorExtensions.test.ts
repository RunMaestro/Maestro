/**
 * Tests for the MarkdownEditor's base extension set.
 *
 * The facet assertions are built as an `EditorState` rather than an
 * `EditorView`: they resolve without a layout engine, which jsdom does not
 * have. The keydown assertions need a real view, because what they are checking
 * is the ORDER the host handler and CodeMirror's own keymap run in, and that
 * order only exists once the extensions are wired to a DOM node. jsdom reports
 * every box as zero-sized, which the caret arithmetic below does not depend on.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildEditorExtensions } from '../../../../renderer/components/FilePreview/markdownEditor/extensions';
import { vimKeysExtension } from '../../../../renderer/components/FilePreview/markdownEditor/vimKeys';

// The Vim block at the bottom puts a real `@replit/codemirror-vim` on a view,
// and the plugin's own panel construction reaches for an IntersectionObserver
// the shared test setup leaves as a non-constructable `vi.fn()`. Swapped for a
// real class and restored in teardown (same dance as GiantPreview.test.tsx).
class StubIntersectionObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
const ioGlobal = globalThis as typeof globalThis & {
	IntersectionObserver: typeof IntersectionObserver;
};
const originalIntersectionObserver = ioGlobal.IntersectionObserver;
ioGlobal.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;

afterAll(() => {
	ioGlobal.IntersectionObserver = originalIntersectionObserver;
});

function stateWith(opts: Partial<Parameters<typeof buildEditorExtensions>[0]>): EditorState {
	return EditorState.create({
		doc: 'hello',
		extensions: buildEditorExtensions({
			wrap: true,
			showLineNumbers: true,
			spellCheck: false,
			...opts,
		}),
	});
}

/** A live view over `stateWith`, caret parked at the start of the document. */
function mountWith(opts: Partial<Parameters<typeof buildEditorExtensions>[0]>): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const view = new EditorView({ state: stateWith(opts), parent });
	view.dispatch({ selection: { anchor: 0 } });
	return view;
}

function press(view: EditorView, key: string): void {
	view.contentDOM.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
	);
}

/**
 * A paste of plain text. jsdom has no `ClipboardEvent` constructor with a
 * working `clipboardData`, so the event is built by hand and the payload is
 * attached to it - which is all CodeMirror's own paste handler reads.
 */
function paste(view: EditorView, text: string): Event {
	const event = new Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', {
		value: { getData: () => text, types: ['text/plain'], items: [], files: [] },
	});
	view.contentDOM.dispatchEvent(event);
	return event;
}

describe('buildEditorExtensions', () => {
	it('leaves the document writable by default', () => {
		const state = stateWith({});
		expect(state.readOnly).toBe(false);
		expect(state.facet(EditorView.editable)).toBe(true);
	});

	it('turns off both editing and the caret when readOnly is set', () => {
		const state = stateWith({ readOnly: true });
		// `readOnly` is what refuses user edits; `editable` is what drops the
		// caret and the contenteditable attribute. A read-only pane needs both,
		// or it reads as a text box that silently ignores typing.
		expect(state.readOnly).toBe(true);
		expect(state.facet(EditorView.editable)).toBe(false);
	});
});

/**
 * The seam that makes a host-owned popup possible over CodeMirror.
 *
 * These assert against the CARET rather than against the mock's return value,
 * because the mock being called proves nothing: the whole question is whether
 * the editor's own keymap got to run afterwards. Reverting `extensions.ts` to
 * the old unconditional `return false` leaves every hook-level autocomplete
 * test green while the arrow keys silently move the cursor out from under the
 * popup, so the check has to live here.
 */
describe('buildEditorExtensions - host keydown', () => {
	it('lets the editor keep a key the host declines', () => {
		const onKeyDown = vi.fn(() => undefined);
		const view = mountWith({ onKeyDown });

		press(view, 'ArrowRight');

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		// Returning anything other than `true` leaves the key to CodeMirror, which
		// is what every pre-existing consumer (the File Preview's Cmd+S / Escape /
		// Cmd+E handler) relies on.
		expect(view.state.selection.main.head).toBe(1);
		view.destroy();
	});

	it('swallows a key the host claims by returning true', () => {
		const onKeyDown = vi.fn(() => true);
		const view = mountWith({ onKeyDown });

		press(view, 'ArrowRight');

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		// Caret parked: the host ran at Prec.highest and consumed the key before
		// the default keymap could move the cursor. This is how the template
		// autocomplete owns Up/Down/Enter/Escape while its popup is open.
		expect(view.state.selection.main.head).toBe(0);
		view.destroy();
	});

	it('behaves exactly as before when no host handler is supplied', () => {
		const view = mountWith({});

		press(view, 'ArrowRight');

		expect(view.state.selection.main.head).toBe(1);
		view.destroy();
	});
});

/**
 * The paste-side twin of the keydown seam, and the reason it has to exist:
 * CodeMirror's own paste handler inserts the clipboard text and stops the
 * chain, so a host that wants to REWRITE a paste (Auto Run trims stray
 * whitespace, and turns a clipboard image into a saved attachment) has to see
 * the event first.
 *
 * The failure this guards against is silent and doubles text: if `onPaste` ran
 * at normal precedence, or its `true` were ignored, the host would insert its
 * rewritten text AND CodeMirror would insert the raw clipboard text after it.
 */
describe('buildEditorExtensions - host paste', () => {
	it('lets the editor keep a paste the host declines', () => {
		const onPaste = vi.fn(() => undefined);
		const view = mountWith({ onPaste });

		paste(view, 'world');

		expect(onPaste).toHaveBeenCalledTimes(1);
		// Declining leaves the insert to CodeMirror, which is the behaviour every
		// surface that only WATCHES pastes depends on.
		expect(view.state.doc.toString()).toBe('worldhello');
		view.destroy();
	});

	it('swallows a paste the host claims by returning true', () => {
		const onPaste = vi.fn(() => true);
		const view = mountWith({ onPaste });

		paste(view, 'world');

		expect(onPaste).toHaveBeenCalledTimes(1);
		// Document untouched: the host ran at Prec.highest and consumed the event,
		// so it is free to insert its own rewritten text without doubling up.
		expect(view.state.doc.toString()).toBe('hello');
		view.destroy();
	});

	it('behaves exactly as before when no host handler is supplied', () => {
		const view = mountWith({});

		paste(view, 'world');

		expect(view.state.doc.toString()).toBe('worldhello');
		view.destroy();
	});
});

describe('buildEditorExtensions - placeholder', () => {
	it('paints the hint while the document is empty', () => {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			state: EditorState.create({
				doc: '',
				extensions: buildEditorExtensions({
					wrap: true,
					showLineNumbers: false,
					spellCheck: false,
					placeholder: 'Capture notes here',
				}),
			}),
			parent,
		});

		expect(view.dom.textContent).toContain('Capture notes here');
		view.destroy();
	});

	it('adds no placeholder widget when none is configured', () => {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			state: EditorState.create({
				doc: '',
				extensions: buildEditorExtensions({
					wrap: true,
					showLineNumbers: false,
					spellCheck: false,
				}),
			}),
			parent,
		});

		expect(view.dom.querySelector('.cm-placeholder')).toBeNull();
		view.destroy();
	});
});

/**
 * The one key family the host hook gives back, asserted against the hook
 * itself rather than through `MarkdownEditor`.
 *
 * `extensions.ts` composes `onKeyDown` at `Prec.highest`, which is the whole
 * point of it - and that precedence runs AHEAD of Vim's own keydown handler.
 * Hosts match their chords with `e.metaKey || e.ctrlKey`, so without the
 * `vimEditorOwnsCtrlChord` early return a Vim user's physical Ctrl+E scrolled
 * nothing and flipped the pane out of edit mode instead.
 *
 * `markdownEditorVim.test.tsx` covers the same gate through the real
 * component; these mount the extension set directly, with the Vim subtree
 * composed in front of it exactly the way `MarkdownEditor` does, so the branch
 * is pinned at the unit that contains it. Deleting the `if` in `extensions.ts`
 * fails here first, with no React in the stack to look past.
 */
describe('buildEditorExtensions - the Vim carve-out on the host hook', () => {
	/** A view with real Vim keys ahead of the extension set, as the editor builds it. */
	function mountVim(onKeyDown: (event: KeyboardEvent) => boolean | void): EditorView {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			state: EditorState.create({
				doc: 'hello',
				// Vim FIRST, which is the order rule 2 in `./vimKeys` requires and
				// `MarkdownEditor` uses. The host hook outranks both from
				// `Prec.highest` regardless, which is what makes the gate necessary.
				extensions: [
					vimKeysExtension(true),
					buildEditorExtensions({
						wrap: true,
						showLineNumbers: true,
						spellCheck: false,
						onKeyDown,
					}),
				],
			}),
			parent,
		});
		view.dispatch({ selection: { anchor: 0 } });
		return view;
	}

	function chord(view: EditorView, key: string, modifiers: KeyboardEventInit): void {
		view.contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
		);
	}

	it('declines a Ctrl chord Vim owns in normal mode', () => {
		const onKeyDown = vi.fn(() => true);
		const view = mountVim(onKeyDown);

		// `<C-e>` scrolls one line down in Vim. In Maestro the same chord is
		// `toggleMarkdownMode`, which the File Preview claims from this hook.
		chord(view, 'e', { ctrlKey: true });

		expect(onKeyDown).not.toHaveBeenCalled();
		view.destroy();
	});

	it('still hands over the Cmd spelling of that chord', () => {
		const onKeyDown = vi.fn(() => true);
		const view = mountVim(onKeyDown);

		// What makes "the editor wins" cost the user nothing: Vim reads the
		// physical `event.ctrlKey`, so Cmd+E is not a Vim key and the edit /
		// preview toggle still works from inside the editor.
		chord(view, 'e', { metaKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].metaKey).toBe(true);
		view.destroy();
	});

	it('still hands over a Ctrl chord Vim does not bind', () => {
		const onKeyDown = vi.fn(() => true);
		const view = mountVim(onKeyDown);

		// A table lookup, not "decline every Ctrl chord". Vim undoes with `u`
		// and redoes with `<C-r>`, so `<C-z>` is nobody's but the host's.
		chord(view, 'z', { ctrlKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].key).toBe('z');
		view.destroy();
	});

	it('hands over a Vim Ctrl chord pressed in insert mode', () => {
		// Declines every key, so `i` below reaches Vim instead of being
		// swallowed by the hook. The readout is still whether the hook was
		// CALLED - the gate's `return false` skips it entirely.
		const onKeyDown = vi.fn(() => false);
		const view = mountVim(onKeyDown);

		// `i` enters insert mode, where the user is TYPING. The gate answers
		// for normal and visual only: a host chord pressed mid-sentence
		// (Cmd+S's Ctrl spelling, Auto Run's Ctrl+L) is far likelier to be what
		// the user meant than a Vim command would be.
		view.contentDOM.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
		);
		onKeyDown.mockClear();

		chord(view, 'e', { ctrlKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].ctrlKey).toBe(true);
		view.destroy();
	});

	it('asks nothing of the gate when the editor has no Vim on it', () => {
		const onKeyDown = vi.fn(() => true);
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			state: stateWith({ onKeyDown }),
			parent,
		});

		// `vimEditorOwnsCtrlChord` resolves through `getCM`, which is null unless
		// the plugin installed itself - so a default-keyboard-mode user sees
		// exactly the behavior this hook had before Vim existed.
		chord(view, 'e', { ctrlKey: true });
		chord(view, 'w', { ctrlKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(2);
		view.destroy();
	});
});
