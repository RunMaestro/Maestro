import { describe, it, expect } from 'vitest';
import { buildBaseExtensions } from '../../../../../renderer/components/FilePreview/giantPreview/extensions';
import { EditorState } from '@codemirror/state';

describe('buildBaseExtensions', () => {
	it('returns an extension array', () => {
		const ext = buildBaseExtensions();
		expect(ext).toBeTruthy();
	});

	it('produces a state that is read-only', () => {
		const state = EditorState.create({
			doc: 'hello',
			extensions: buildBaseExtensions(),
		});
		expect(state.readOnly).toBe(true);
	});

	it('starts with the document the caller provided', () => {
		const state = EditorState.create({
			doc: 'first\nsecond\nthird',
			extensions: buildBaseExtensions(),
		});
		expect(state.doc.toString()).toBe('first\nsecond\nthird');
		expect(state.doc.lines).toBe(3);
	});

	it('signals readOnly via state.readOnly so user-event handlers can refuse edits', () => {
		// CM6's readOnly facet doesn't filter programmatic transactions; it
		// signals to the input/event layer to drop user-originated changes.
		// The flag MUST be true so the input handler knows what to do.
		const state = EditorState.create({
			doc: 'abc',
			extensions: buildBaseExtensions(),
		});
		expect(state.readOnly).toBe(true);
	});

	it('handles an empty document', () => {
		const state = EditorState.create({
			doc: '',
			extensions: buildBaseExtensions(),
		});
		expect(state.doc.length).toBe(0);
	});

	it('handles a multi-MB document without throwing', () => {
		const big = 'line\n'.repeat(200_000);
		expect(() =>
			EditorState.create({
				doc: big,
				extensions: buildBaseExtensions(),
			})
		).not.toThrow();
	});

	it('handles a pathologically long single line without throwing', () => {
		// Regression: `edge-one-huge-line.txt` (500 KB of 'A's, no newlines)
		// would freeze the renderer because lineWrapping alone (white-space:
		// pre-wrap) doesn't break a no-whitespace line, leaving the browser
		// to render one multi-million-pixel-wide DOM element. The base
		// extensions now pair lineWrapping with overflow-wrap: anywhere so
		// the browser can break at character boundaries.
		const huge = 'A'.repeat(500_000);
		expect(() =>
			EditorState.create({
				doc: huge,
				extensions: buildBaseExtensions(),
			})
		).not.toThrow();
	});
});
