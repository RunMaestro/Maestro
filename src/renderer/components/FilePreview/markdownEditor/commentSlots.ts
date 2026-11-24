/**
 * Review comment slots for the CodeMirror editor: the GitHub-style "comment
 * under the line" layout of the Git Diff viewer, inside a text editor.
 *
 * The host says which lines carry a comment (`setCommentSlots`). For each slot
 * the editor tints the commented lines and reserves an empty block element
 * under the last one. The host renders the shared review components
 * (`ReviewCommentCard`, `ReviewCommentEditor`) into those elements with React
 * portals, so the editor never knows what a comment looks like and the comment
 * box never knows it lives inside CodeMirror.
 *
 * A slot element is handed to the host through `onSlotElement(id, el)` when
 * CodeMirror creates it, and `onSlotElement(id, null, el)` when it goes away.
 * Events inside a slot belong to the slot (`ignoreEvent`), so typing in a
 * comment box never edits the document.
 */
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** One comment (or the open comment box) and the lines it covers. */
export interface CommentSlot {
	/** Stable id: the comment id, or a fixed id for the open box. */
	id: string;
	/** 1-based, inclusive. The slot hangs under `endLine`. */
	startLine: number;
	endLine: number;
}

export interface CommentSlotsPayload {
	slots: readonly CommentSlot[];
	/** Background of a commented line (any CSS color). */
	lineColor: string;
}

/** Replace every slot. Dispatch with an empty list to clear them. */
export const setCommentSlots = StateEffect.define<CommentSlotsPayload>();

/** Hands a slot's element to the host; `el` is null when the slot goes away. */
export type CommentSlotElementCallback = (
	id: string,
	el: HTMLElement | null,
	previous?: HTMLElement
) => void;

/** CSS class of a slot element (tests and styling find it by this). */
export const COMMENT_SLOT_CLASS = 'cm-review-comment-slot';

class CommentSlotWidget extends WidgetType {
	constructor(
		readonly id: string,
		private readonly onSlotElement: CommentSlotElementCallback
	) {
		super();
	}

	eq(other: CommentSlotWidget): boolean {
		return other.id === this.id;
	}

	toDOM(view: EditorView): HTMLElement {
		const el = document.createElement('div');
		el.className = COMMENT_SLOT_CLASS;
		el.dataset.commentSlot = this.id;
		el.contentEditable = 'false';
		// The portal fills the slot after CodeMirror measured it empty; re-measure
		// whenever its height changes so the lines below do not overlap it.
		if (typeof ResizeObserver !== 'undefined') {
			const observer = new ResizeObserver(() => view.requestMeasure());
			observer.observe(el);
			slotObservers.set(el, observer);
		}
		this.onSlotElement(this.id, el);
		return el;
	}

	destroy(dom: HTMLElement): void {
		slotObservers.get(dom)?.disconnect();
		slotObservers.delete(dom);
		this.onSlotElement(this.id, null, dom);
	}

	get estimatedHeight(): number {
		return 64;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

const slotObservers = new WeakMap<HTMLElement, ResizeObserver>();

function buildDecorations(
	doc: EditorView['state']['doc'],
	payload: CommentSlotsPayload,
	onSlotElement: CommentSlotElementCallback
): DecorationSet {
	const lineDecoration = Decoration.line({
		attributes: { style: `background-color: ${payload.lineColor}` },
	});
	const ranges: Range<Decoration>[] = [];
	const tinted = new Set<number>();
	for (const slot of payload.slots) {
		const last = Math.min(Math.max(1, slot.endLine), doc.lines);
		const first = Math.min(Math.max(1, slot.startLine), last);
		for (let n = first; n <= last; n++) {
			if (tinted.has(n)) continue;
			tinted.add(n);
			ranges.push(lineDecoration.range(doc.line(n).from));
		}
		ranges.push(
			Decoration.widget({
				widget: new CommentSlotWidget(slot.id, onSlotElement),
				block: true,
				side: 1,
			}).range(doc.line(last).to)
		);
	}
	// `true`: let CodeMirror sort them (line tints and slots interleave).
	return Decoration.set(ranges, true);
}

/**
 * The slot field. Slots follow their text as the user types (the decorations
 * map through every change) until the host replaces them.
 */
export function commentSlotsExtension(onSlotElement: CommentSlotElementCallback): Extension {
	const field = StateField.define<DecorationSet>({
		create: () => Decoration.none,
		update(decorations, tr) {
			let next = decorations.map(tr.changes);
			for (const effect of tr.effects) {
				if (effect.is(setCommentSlots)) {
					next = buildDecorations(tr.state.doc, effect.value, onSlotElement);
				}
			}
			return next;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	return field;
}
