import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
	problemMarkExtension,
	setProblemRangeEffect,
} from '../../../../renderer/components/FilePreview/markdownEditor/problemMark';

/** Every painted span as `[from, to, class, title]`, read from the decorations facet. */
function marks(state: EditorState) {
	const found: Array<[number, number, unknown, unknown]> = [];
	for (const source of state.facet(EditorView.decorations)) {
		if (typeof source === 'function') continue;
		source.between(0, state.doc.length, (from, to, value) => {
			found.push([from, to, value.spec.class, value.spec.attributes?.title]);
		});
	}
	return found;
}

function stateWith(doc: string) {
	return EditorState.create({ doc, extensions: [problemMarkExtension()] });
}

describe('problemMarkExtension', () => {
	it('paints the span the host flags, its message as the tooltip', () => {
		const state = stateWith('SELECT * FORM t').update({
			effects: setProblemRangeEffect.of({ from: 9, to: 13, message: 'near "FORM": syntax error' }),
		}).state;
		expect(marks(state)).toEqual([[9, 13, 'cm-app-problem', 'near "FORM": syntax error']]);
	});

	it('replaces the span on the next one, and clears it on null', () => {
		let state = stateWith('SELECT a, b FROM t');
		state = state.update({ effects: setProblemRangeEffect.of({ from: 7, to: 8 }) }).state;
		state = state.update({ effects: setProblemRangeEffect.of({ from: 10, to: 11 }) }).state;
		expect(marks(state)).toEqual([[10, 11, 'cm-app-problem', undefined]]);
		state = state.update({ effects: setProblemRangeEffect.of(null) }).state;
		expect(marks(state)).toEqual([]);
	});

	it('keeps the span on its text through an edit before it', () => {
		let state = stateWith('SELECT * FORM t');
		state = state.update({ effects: setProblemRangeEffect.of({ from: 9, to: 13 }) }).state;
		state = state.update({ changes: { from: 0, insert: '-- note\n' } }).state;
		expect(marks(state)).toEqual([[17, 21, 'cm-app-problem', undefined]]);
		expect(state.sliceDoc(17, 21)).toBe('FORM');
	});

	it('drops a span that no longer fits the document, rather than throwing', () => {
		const state = stateWith('SELECT 1').update({
			effects: setProblemRangeEffect.of({ from: 20, to: 25 }),
		}).state;
		expect(marks(state)).toEqual([]);
	});
});
