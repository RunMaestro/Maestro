/**
 * Integration tests for Vim keys inside `MarkdownEditor`.
 *
 * These mount the REAL CodeMirror 6 view (the way the Giant tier's test does)
 * rather than the shared `markdownEditorModuleMock`, because what is under test
 * is the composition itself: `vim()` sitting ahead of the base compartment's
 * `keymap.of([...defaultKeymap])`, the host keydown hook still outranking both
 * at `Prec.highest`, and the search-highlight field still painting underneath.
 * A mocked editor would answer none of those.
 *
 * jsdom has no layout engine, so nothing here depends on a measured box - only
 * on the document, the selection, and the classes CM6 writes.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, act } from '@testing-library/react';
import { mockTheme } from '../../../helpers/mockTheme';

// CM6 builds a MutationObserver / ResizeObserver / IntersectionObserver inside
// its DOMObserver. The shared test setup leaves IntersectionObserver as a
// non-constructable vi.fn(), which crashes CM6, so swap in a real class and
// restore it in teardown (same dance as GiantPreview.test.tsx).
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

// Skip the lazy `@codemirror/lang-*` dynamic imports: they are irrelevant here
// and resolving them mid-test makes the assertions order-dependent.
vi.mock('../../../../renderer/components/FilePreview/giantPreview/languageLoader', () => ({
	loadLanguageExtension: vi.fn(async () => null),
	hasLanguageSupport: () => false,
}));

import { MarkdownEditor } from '../../../../renderer/components/FilePreview/markdownEditor';
import type { MarkdownEditorHandle } from '../../../../renderer/components/FilePreview/markdownEditor';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

/**
 * Mount the editor. `vimMode` writes the app-wide keyboard-mode setting the
 * editor reads, which is the only switch Vim keys hang off.
 */
function mountEditor(opts: {
	vimMode: boolean;
	doc?: string;
	onChange?: (value: string) => void;
	onKeyDown?: (event: KeyboardEvent) => boolean | void;
}) {
	useSettingsStore.setState({ keyboardMode: opts.vimMode ? 'vim' : 'default' });
	const ref = { current: null } as React.MutableRefObject<MarkdownEditorHandle | null>;
	const result = render(
		<MarkdownEditor
			ref={ref}
			value={opts.doc ?? 'hello world'}
			onChange={opts.onChange ?? (() => {})}
			language="text"
			theme={mockTheme}
			onKeyDown={opts.onKeyDown}
		/>
	);
	return { ...result, ref };
}

/** The text CM6 is currently showing, with its line separators collapsed. */
function docText(container: HTMLElement): string {
	return Array.from(container.querySelectorAll('.cm-line'))
		.map((el) => el.textContent ?? '')
		.join('\n');
}

function contentDom(container: HTMLElement): HTMLElement {
	const el = container.querySelector('.cm-content');
	if (!el) throw new Error('CM6 content element did not mount');
	return el as HTMLElement;
}

/** A keydown on the editor's content element, the way a focused user types. */
function press(
	container: HTMLElement,
	key: string,
	modifiers: Partial<Pick<KeyboardEventInit, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}
): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		...modifiers,
	});
	act(() => {
		contentDom(container).dispatchEvent(event);
	});
	return event;
}

beforeEach(() => {
	useSettingsStore.setState({ keyboardMode: 'default' });
});

describe('MarkdownEditor - Vim gating', () => {
	it('leaves Vim out in default keyboard mode', () => {
		const { container } = mountEditor({ vimMode: false });

		// The Vim plugin tags the scroller the moment it enters normal mode, so
		// the absence of the class is the absence of the extension.
		expect(container.querySelector('.cm-vimMode')).toBeNull();

		// And the keys stay literal: `x` is not a delete command.
		press(container, 'x');
		expect(docText(container)).toBe('hello world');
	});

	it('runs real Vim commands in Vim keyboard mode', () => {
		const { container } = mountEditor({ vimMode: true });

		expect(container.querySelector('.cm-vimMode')).not.toBeNull();

		// `x` in normal mode deletes the character under the caret. This is the
		// package's own grammar running, not a motion subset we wrote.
		press(container, 'x');
		expect(docText(container)).toBe('ello world');
	});

	it('moves the caret on a bare normal-mode motion', () => {
		const { container, ref } = mountEditor({ vimMode: true, doc: 'alpha beta' });

		act(() => {
			ref.current!.setSelection(0, 0);
		});
		press(container, 'w');

		// `w` is bound by nothing in the base extension set, so the caret landing
		// on the next word is Vim's motion grammar running. (A vertical motion
		// would be the more obvious choice, but `j` goes through CM6's
		// `moveVertically`, which needs real line heights jsdom does not have.)
		expect(ref.current!.getCaret()).toBe(6);
	});

	it('is offered a key BEFORE the default keymap', () => {
		const { container, ref } = mountEditor({ vimMode: true, doc: '5' });

		act(() => {
			ref.current!.setSelection(0, 0);
		});
		// Ctrl+A is bound by BOTH: `defaultKeymap` maps Mod-a to select-all, Vim
		// maps <C-a> to "increment the number under the cursor". They sit at the
		// same precedence, so whichever is composed first wins - which makes the
		// document the readout for the ordering the package's README requires.
		// Move `compartments.vim.of(...)` after the base compartment and this
		// flips to a select-all with the doc untouched.
		press(container, 'a', { ctrlKey: true });

		expect(docText(container)).toBe('6');
	});
});

/**
 * The seams the File Preview host depends on. Vim binds a large part of the
 * keyboard, so each of these is a thing that would silently stop working if the
 * extension had been composed at the wrong precedence.
 */
describe('MarkdownEditor - Vim alongside the host', () => {
	it('still hands Cmd+S to the host save path', () => {
		const onKeyDown = vi.fn(() => true);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		press(container, 's', { metaKey: true });

		// The host's hook rides at Prec.highest inside the base compartment, which
		// outranks array order, so it sees the key ahead of Vim. FilePreview's
		// handler is what calls handleSave().
		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].key).toBe('s');
		// Claimed by the host, so Vim never saw it: `s` in normal mode would
		// otherwise have deleted the character under the caret.
		expect(docText(container)).toBe('hello world');
	});

	it('still hands the Cmd+E edit/preview toggle to the host', () => {
		const onKeyDown = vi.fn(() => true);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		press(container, 'e', { metaKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].key).toBe('e');
		expect(onKeyDown.mock.calls[0][0].metaKey).toBe(true);
		expect(docText(container)).toBe('hello world');
	});

	it('reports a Vim edit through onChange so the save path sees it', () => {
		const onChange = vi.fn();
		const { container } = mountEditor({ vimMode: true, onChange });

		// `dd` deletes the line. The update listener is what marks the file dirty
		// and feeds autosave, so a Vim edit that bypassed it would be lost.
		press(container, 'd');
		press(container, 'd');

		expect(onChange).toHaveBeenCalled();
		expect(onChange.mock.calls[onChange.mock.calls.length - 1][0]).toBe('');
	});

	it('still paints the host search bar matches', () => {
		const { container, ref } = mountEditor({ vimMode: true });

		act(() => {
			ref.current!.setSearchMatches([{ from: 0, to: 5 }], 0);
		});

		// `searchHighlight.ts` is a separate state field, and Vim brings search
		// decorations of its own; both have to coexist.
		expect(container.querySelector('.cm-app-search-match')).not.toBeNull();
		expect(container.querySelector('.cm-app-search-current')).not.toBeNull();
	});
});

/**
 * Toggling the setting mid-edit must cost the user nothing. The compartment is
 * reconfigured in place, so the `EditorState` - document, selection, scroll,
 * and the history field in the untouched base compartment - carries over.
 */
describe('MarkdownEditor - switching keyboard mode in place', () => {
	it('keeps the same editor instance, document, and caret', () => {
		const { container, ref } = mountEditor({ vimMode: false, doc: 'alpha\nbeta\ngamma' });
		const editorBefore = container.querySelector('.cm-editor');

		act(() => {
			ref.current!.setSelection(8, 8);
		});
		expect(ref.current!.getCaret()).toBe(8);

		act(() => {
			useSettingsStore.setState({ keyboardMode: 'vim' });
		});

		// Same DOM node: the view was reconfigured, not rebuilt. A rebuild is what
		// would have thrown away the caret and the scroll offset below.
		expect(container.querySelector('.cm-editor')).toBe(editorBefore);
		expect(container.querySelector('.cm-vimMode')).not.toBeNull();
		expect(docText(container)).toBe('alpha\nbeta\ngamma');
		expect(ref.current!.getCaret()).toBe(8);
	});

	it('keeps the undo history across the switch', () => {
		const { container, ref } = mountEditor({ vimMode: false, doc: 'hello' });

		act(() => {
			ref.current!.replaceRange(0, 0, 'X');
		});
		expect(docText(container)).toBe('Xhello');

		act(() => {
			useSettingsStore.setState({ keyboardMode: 'vim' });
		});

		// Vim's own `u` reads the same history field the base compartment
		// installed. If the switch had rebuilt the state, there would be nothing
		// to undo and the X would stay.
		press(container, 'u');
		expect(docText(container)).toBe('hello');
	});

	it('drops Vim again when the user switches back', () => {
		const { container } = mountEditor({ vimMode: true });
		expect(container.querySelector('.cm-vimMode')).not.toBeNull();

		act(() => {
			useSettingsStore.setState({ keyboardMode: 'default' });
		});

		expect(container.querySelector('.cm-vimMode')).toBeNull();
		press(container, 'x');
		expect(docText(container)).toBe('hello world');
	});
});
