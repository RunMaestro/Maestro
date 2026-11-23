/**
 * Tests for the editor half of File Preview review comments:
 *
 *  - `commentSlotsExtension` tints the commented lines and reserves one block
 *    element under each slot's last line, handed to the host (which renders
 *    the shared comment card / box into it with a portal).
 *  - `onLineContextMenu` turns a right-click on a line's text into its line
 *    number, without taking over a right-click on the selection or the native
 *    spellcheck menu.
 *
 * jsdom has no layout, so the click's document position is stood in with a
 * `posAtCoords` stub; everything else runs through a real EditorView.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
	COMMENT_SLOT_CLASS,
	commentSlotsExtension,
	setCommentSlots,
} from '../../../../renderer/components/FilePreview/markdownEditor/commentSlots';
import { buildEditorExtensions } from '../../../../renderer/components/FilePreview/markdownEditor/extensions';

const DOC = 'one\ntwo\nthree\nfour';

function mount(extensions: Extension): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	return new EditorView({ state: EditorState.create({ doc: DOC, extensions }), parent });
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('commentSlotsExtension', () => {
	it('hands the host one slot element per comment and tints its lines', () => {
		const onSlot = vi.fn();
		const view = mount(commentSlotsExtension(onSlot));
		view.dispatch({
			effects: setCommentSlots.of({
				slots: [{ id: 'c1', startLine: 2, endLine: 3 }],
				lineColor: 'rgba(1, 2, 3, 0.5)',
			}),
		});

		const slot = view.dom.querySelector<HTMLElement>(`.${COMMENT_SLOT_CLASS}`);
		expect(slot?.dataset.commentSlot).toBe('c1');
		expect(slot?.contentEditable).toBe('false');
		expect(onSlot).toHaveBeenCalledWith('c1', slot);

		const tinted = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-line'))
			.filter((line) => line.style.backgroundColor)
			.map((line) => line.textContent);
		expect(tinted).toEqual(['two', 'three']);
		// The slot hangs under the LAST commented line.
		expect(slot?.previousElementSibling?.textContent).toBe('three');
		view.destroy();
	});

	it('tells the host when a slot goes away', () => {
		const onSlot = vi.fn();
		const view = mount(commentSlotsExtension(onSlot));
		const payload = { slots: [{ id: 'c1', startLine: 1, endLine: 1 }], lineColor: 'red' };
		view.dispatch({ effects: setCommentSlots.of(payload) });
		const el = onSlot.mock.calls[0][1];
		view.dispatch({ effects: setCommentSlots.of({ ...payload, slots: [] }) });
		expect(onSlot).toHaveBeenLastCalledWith('c1', null, el);
		expect(view.dom.querySelector(`.${COMMENT_SLOT_CLASS}`)).toBeNull();
		view.destroy();
	});

	it('clamps a slot past the end of the document onto the last line', () => {
		const view = mount(commentSlotsExtension(vi.fn()));
		view.dispatch({
			effects: setCommentSlots.of({
				slots: [{ id: 'x', startLine: 9, endLine: 12 }],
				lineColor: 'red',
			}),
		});
		const slot = view.dom.querySelector(`.${COMMENT_SLOT_CLASS}`);
		expect(slot?.previousElementSibling?.textContent).toBe('four');
		view.destroy();
	});
});

describe('onLineContextMenu', () => {
	function mountMenus(opts: { spellCheck?: boolean } = {}) {
		const onLine = vi.fn();
		const onSelection = vi.fn();
		const view = mount(
			buildEditorExtensions({
				wrap: true,
				showLineNumbers: true,
				spellCheck: opts.spellCheck ?? false,
				onLineContextMenu: onLine,
				onSelectionContextMenu: onSelection,
			})
		);
		return { view, onLine, onSelection };
	}

	function rightClickAt(view: EditorView, pos: number): MouseEvent {
		vi.spyOn(view, 'posAtCoords').mockReturnValue(pos);
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		view.contentDOM.dispatchEvent(event);
		return event;
	}

	it('reports the line under the pointer and claims the event', () => {
		const { view, onLine, onSelection } = mountMenus();
		// Offset 9 is inside "three", line 3.
		const event = rightClickAt(view, 9);
		expect(onLine).toHaveBeenCalledWith(3, event);
		expect(onSelection).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(true);
		view.destroy();
	});

	it('leaves a right-click on the selection to the selection menu', () => {
		const { view, onLine, onSelection } = mountMenus();
		view.dispatch({ selection: { anchor: 4, head: 13 } });
		rightClickAt(view, 6);
		expect(onSelection).toHaveBeenCalledWith(
			expect.objectContaining({ startLine: 2, endLine: 3 }),
			expect.any(MouseEvent)
		);
		expect(onLine).not.toHaveBeenCalled();
		view.destroy();
	});

	it('keeps the native menu while spellcheck is on (its "Did you mean" lives there)', () => {
		const { view, onLine } = mountMenus({ spellCheck: true });
		const event = rightClickAt(view, 9);
		expect(onLine).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
		view.destroy();
	});
});
