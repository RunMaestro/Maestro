import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * CodeMirror extension that paints ONE span the host flags as wrong, such as
 * the token a SQL error points at (the SQLite viewer's Query mode), with a
 * wavy underline in the theme's error color and the problem as its tooltip.
 *
 * Driven by the editor's `problemRange` prop: the host dispatches
 * `setProblemRangeEffect` with the span, or null to clear it. The mark maps
 * through edits, so it stays on its text while the person types elsewhere.
 * Styled by the shared editor theme (`.cm-app-problem`, see themeAdapter).
 */
export interface ProblemRange {
	from: number;
	to: number;
	/** Shown as the span's tooltip. */
	message?: string;
}

export const setProblemRangeEffect = StateEffect.define<ProblemRange | null>();

function buildDecoration(range: ProblemRange | null, docLength: number): DecorationSet {
	if (!range) return Decoration.none;
	// The host computed the span against its own copy of the text; one that
	// no longer fits the live document is dropped rather than let CM6 throw.
	const from = Math.max(0, range.from);
	const to = Math.min(range.to, docLength);
	if (from >= to) return Decoration.none;
	const mark = Decoration.mark({
		class: 'cm-app-problem',
		attributes: range.message ? { title: range.message } : undefined,
	});
	return Decoration.set([mark.range(from, to)]);
}

export function problemMarkExtension(): Extension {
	return StateField.define<DecorationSet>({
		create() {
			return Decoration.none;
		},
		update(value, tr) {
			let next = value.map(tr.changes);
			for (const effect of tr.effects) {
				if (effect.is(setProblemRangeEffect)) {
					next = buildDecoration(effect.value, tr.state.doc.length);
				}
			}
			return next;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}
