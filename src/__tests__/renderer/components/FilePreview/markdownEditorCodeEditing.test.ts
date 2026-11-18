/**
 * Tests for the File Preview code-editor set (markdownEditor/codeEditing.ts).
 *
 * Facet checks run on a bare `EditorState`. Key checks need a live view,
 * because the question is which handler answers a key and whether the window
 * ever sees it. jsdom gives CodeMirror an empty `navigator.platform`, so CM
 * treats `Mod` as Ctrl; the platform is pinned to linux for these tests so
 * Maestro's own `isMacOS()` agrees with it.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { completeAnyWord } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import {
	buildEditorExtensions,
	mainSelectionDetails,
} from '../../../../renderer/components/FilePreview/markdownEditor/extensions';
import {
	APP_OWNED_EDITOR_CHORDS,
	CODE_EDITOR_SHORTCUT_IDS,
	editorClaimsKey,
	withoutAppOwnedChords,
	type BuildCodeEditingExtensionsOptions,
} from '../../../../renderer/components/FilePreview/markdownEditor/codeEditing';
import { FIXED_SHORTCUTS } from '../../../../renderer/constants/shortcuts';

// Renderer tests compile without Node's types; reach `process` through globalThis.
const proc = (globalThis as unknown as { process: { platform: string } }).process;
const originalPlatform = proc.platform;
beforeAll(() => {
	Object.defineProperty(proc, 'platform', { value: 'linux', configurable: true });
});
afterAll(() => {
	Object.defineProperty(proc, 'platform', { value: originalPlatform, configurable: true });
});

type BaseOpts = Parameters<typeof buildEditorExtensions>[0];

const CODE: BuildCodeEditingExtensionsOptions = { completion: 'typing' };

function stateWith(
	doc: string,
	opts: Partial<BaseOpts> = {},
	extra: Extension[] = []
): EditorState {
	return EditorState.create({
		doc,
		extensions: [
			buildEditorExtensions({ wrap: true, showLineNumbers: false, spellCheck: false, ...opts }),
			...extra,
		],
	});
}

function mount(doc: string, opts: Partial<BaseOpts> = {}, extra: Extension[] = []): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	return new EditorView({ state: stateWith(doc, opts, extra), parent });
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	view.contentDOM.dispatchEvent(event);
	return event;
}

function boundKeys(state: EditorState): string[] {
	return state
		.facet(keymap)
		.flat()
		.flatMap((b: KeyBinding) => [b.key, b.mac].filter((k): k is string => !!k));
}

describe('code-editing extension set', () => {
	it('is off unless asked for, so prose editors keep their behavior', () => {
		const plain = stateWith('x');
		expect(plain.facet(EditorState.allowMultipleSelections)).toBe(false);
		expect(plain.languageDataAt('autocomplete', 0)).not.toContain(completeAnyWord);
	});

	it('turns on multiple selections and document-word completion', () => {
		const state = stateWith('x', { codeEditing: CODE });
		expect(state.facet(EditorState.allowMultipleSelections)).toBe(true);
		expect(state.languageDataAt('autocomplete', 0)).toContain(completeAnyWord);
	});

	it('skips completion entirely when it is off (Giant-tier sizes)', () => {
		const state = stateWith('x', { codeEditing: { completion: 'off' } });
		expect(state.facet(EditorState.allowMultipleSelections)).toBe(true);
		expect(state.languageDataAt('autocomplete', 0)).not.toContain(completeAnyWord);
	});

	it("drops CodeMirror's bindings for chords Maestro owns", () => {
		expect(boundKeys(stateWith('x'))).toEqual(expect.arrayContaining(['Mod-[', 'Mod-]']));
		const keys = boundKeys(stateWith('x', { codeEditing: CODE }));
		for (const chord of APP_OWNED_EDITOR_CHORDS) expect(keys).not.toContain(chord);
	});

	it('withoutAppOwnedChords filters by key and by mac key', () => {
		const run = () => true;
		const kept = withoutAppOwnedChords([
			{ key: 'Mod-[', run },
			{ key: 'Ctrl-x', mac: 'Mod-]', run },
			{ key: 'Mod-z', run },
		]);
		expect(kept.map((b) => b.key)).toEqual(['Mod-z']);
	});

	it('registers every tracked chord as a FIXED shortcut, for keyboard mastery', () => {
		for (const id of Object.values(CODE_EDITOR_SHORTCUT_IDS)) {
			expect(FIXED_SHORTCUTS[id], `${id} missing from FIXED_SHORTCUTS`).toBeDefined();
		}
	});
});

describe('editing chords', () => {
	it('toggles a comment and keeps Ctrl+/ from reaching the window (Show Shortcuts)', () => {
		const onShortcutUsed = vi.fn();
		const view = mount('hello', { codeEditing: { completion: 'off', onShortcutUsed } }, [
			javascript(),
		]);
		const reachedWindow = vi.fn();
		window.addEventListener('keydown', reachedWindow);

		press(view, '/', { ctrlKey: true });

		window.removeEventListener('keydown', reachedWindow);
		expect(view.state.doc.toString()).toBe('// hello');
		expect(reachedWindow).not.toHaveBeenCalled();
		expect(onShortcutUsed).toHaveBeenCalledWith('editorToggleComment');
		view.destroy();
	});

	it('Ctrl+D adds a cursor at the next occurrence', () => {
		const view = mount('foo bar foo', { codeEditing: CODE });
		view.dispatch({ selection: EditorSelection.single(0, 3) });

		press(view, 'd', { ctrlKey: true });

		expect(view.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
			[0, 3],
			[8, 11],
		]);
		view.destroy();
	});

	it('Alt+ArrowDown moves the line, Shift+Alt+ArrowDown duplicates it', () => {
		const view = mount('one\ntwo', { codeEditing: CODE });
		view.dispatch({ selection: { anchor: 0 } });

		press(view, 'ArrowDown', { altKey: true });
		expect(view.state.doc.toString()).toBe('two\none');

		press(view, 'ArrowDown', { altKey: true, shiftKey: true });
		expect(view.state.doc.toString()).toBe('two\none\none');
		view.destroy();
	});

	it('auto-closes brackets and quotes', () => {
		const view = mount('', { codeEditing: { completion: 'off' } });
		// Typing reaches closeBrackets through the input handler facet, so call
		// the handlers the way CodeMirror does for one typed character.
		const type = (text: string) => {
			const pos = view.state.selection.main.head;
			const fallback = () => view.state.update({ changes: { from: pos, insert: text } });
			const handled = view.state
				.facet(EditorView.inputHandler)
				.some((handler) => handler(view, pos, pos, text, fallback));
			if (!handled) view.dispatch(fallback());
		};

		type('(');
		expect(view.state.doc.toString()).toBe('()');
		type('"');
		expect(view.state.doc.toString()).toBe('("")');
		view.destroy();
	});
});

describe('Escape with several cursors', () => {
	it('collapses to one cursor instead of handing Escape to the host', () => {
		const onKeyDown = vi.fn(() => true);
		const view = mount('abc', { codeEditing: CODE, onKeyDown });
		view.dispatch({
			selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]),
		});

		press(view, 'Escape');

		expect(onKeyDown).not.toHaveBeenCalled();
		expect(view.state.selection.ranges).toHaveLength(1);
		view.destroy();
	});

	it('still reaches the host with one cursor (Escape leaves the editor)', () => {
		const onKeyDown = vi.fn(() => true);
		const view = mount('abc', { codeEditing: CODE, onKeyDown });

		press(view, 'Escape');

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		view.destroy();
	});

	it('editorClaimsKey only claims Escape when there is more than one range', () => {
		const one = stateWith('abc', { codeEditing: CODE });
		const two = one.update({
			selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]),
		}).state;
		const esc = new KeyboardEvent('keydown', { key: 'Escape' });
		expect(editorClaimsKey(esc, one)).toBe(false);
		expect(editorClaimsKey(esc, two)).toBe(true);
		expect(editorClaimsKey(new KeyboardEvent('keydown', { key: 'Enter' }), two)).toBe(false);
	});
});

describe('mainSelectionDetails', () => {
	const at = (doc: string, from: number, to: number) =>
		mainSelectionDetails(EditorState.create({ doc, selection: EditorSelection.single(from, to) }));

	it('is null for a bare caret', () => {
		expect(at('abc', 1, 1)).toBeNull();
	});

	it('reports the text and its 1-based line span', () => {
		expect(at('one\ntwo\nthree', 4, 13)).toEqual({
			text: 'two\nthree',
			from: 4,
			to: 13,
			startLine: 2,
			endLine: 3,
		});
	});

	it('does not count the line a drag-selection ends at column 0 of', () => {
		// Selecting "one\ntwo\n" by dragging down lands the head at the start of line 3.
		expect(at('one\ntwo\nthree', 0, 8)?.endLine).toBe(2);
	});
});
