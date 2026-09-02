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

import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildEditorExtensions } from '../../../../renderer/components/FilePreview/markdownEditor/extensions';

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
