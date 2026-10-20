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

import {
	MarkdownEditor,
	vimEditorAt,
	vimEditorOwnsEscape,
} from '../../../../renderer/components/FilePreview/markdownEditor';
import type { MarkdownEditorHandle } from '../../../../renderer/components/FilePreview/markdownEditor';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useModalLayer } from '../../../../renderer/hooks/ui/useModalLayer';

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

/**
 * The collisions between CodeMirror Vim and Maestro's keyboard layer, resolved.
 *
 * The decisions themselves, and the table of every Ctrl chord the package
 * registers, live beside `vimEditorOwnsCtrlChord` in `markdownEditor/vimKeys`;
 * the audit of that table against the Vim-mode binding set is in
 * `markdownEditorVimCollisions.test.ts`. What is under test here is the
 * mechanism: which handler actually receives the key.
 *
 * Two mechanisms, and they are not alike. A chord Vim handles is swallowed on
 * the content element with `stopPropagation`, so Maestro's window-level
 * handler never sees it - nothing had to be written for that, only proven. A
 * chord a HOST hook claims at `Prec.highest` runs ahead of Vim, which is the
 * one place that needed a gate.
 */
describe('MarkdownEditor - Vim against Maestro keyboard layer', () => {
	/** Keys that reached `window`, where `useMainKeyboardHandler` listens. */
	function watchWindow(): { keys: () => string[]; stop: () => void } {
		const seen: string[] = [];
		const listener = (e: Event) => {
			const k = e as KeyboardEvent;
			seen.push(`${k.ctrlKey ? 'Ctrl+' : ''}${k.metaKey ? 'Meta+' : ''}${k.key}`);
		};
		window.addEventListener('keydown', listener);
		return { keys: () => seen, stop: () => window.removeEventListener('keydown', listener) };
	}

	it('swallows Ctrl+W before it can close the tab', () => {
		const { container } = mountEditor({ vimMode: true });
		const win = watchWindow();

		try {
			// `<C-w>` is Vim's window prefix. The package registers it in normal
			// mode as an inert placeholder, which still counts as handled - so the
			// keypress ends on the content element and `closeTab` (Cmd/Ctrl+W, and
			// the matcher treats those as one binding) never fires. Losing the
			// document because the user reached for `<C-w>` is the single worst
			// outcome on this list.
			const event = press(container, 'w', { ctrlKey: true });

			expect(event.defaultPrevented).toBe(true);
			expect(win.keys()).toEqual([]);
		} finally {
			win.stop();
		}
	});

	it('leaves the Cmd spelling of the same chord to Maestro', () => {
		const { container } = mountEditor({ vimMode: true });
		const win = watchWindow();

		try {
			// This is what makes "the editor wins" cost nothing. Vim reads the
			// PHYSICAL `event.ctrlKey`, so Cmd+W is not a Vim key at all and
			// still reaches the window handler that closes the tab. Every chord
			// in the table keeps a working Cmd spelling for the same reason.
			const event = press(container, 'w', { metaKey: true });

			expect(event.defaultPrevented).toBe(false);
			expect(win.keys()).toEqual(['Meta+w']);
		} finally {
			win.stop();
		}
	});

	it('swallows Ctrl+O before it can move focus to another agent', () => {
		const { container } = mountEditor({ vimMode: true });
		const win = watchWindow();

		try {
			// `<C-o>` walks the jump list back. In Maestro it is `agentSwitcher`,
			// which replaces the whole workspace - so a Vim user navigating their
			// own document would find themselves looking at a different agent.
			const event = press(container, 'o', { ctrlKey: true });

			expect(event.defaultPrevented).toBe(true);
			expect(win.keys()).toEqual([]);
		} finally {
			win.stop();
		}
	});

	it('swallows the redo and visual-block chords too', () => {
		const { container } = mountEditor({ vimMode: true, doc: 'a\nb\nc\nd' });
		const win = watchWindow();

		try {
			// `<C-r>` (redo, which Maestro gives to `toggleReadOnlyMode`) and
			// `<C-v>` (blockwise visual mode, free in Vim mode) - two more rows of
			// the table, same mechanism.
			//
			// The scroll and vertical-motion chords are deliberately NOT here.
			// `<C-e>`, `<C-u>`, `<C-d>` and `<C-n>` all resolve through a measured
			// line box, and jsdom has no layout engine, so they throw out of the
			// package rather than completing - a jsdom limit with nothing to say
			// about the collision. `<C-e>`'s gate is covered below, where the
			// readout is the host hook rather than Vim.
			expect(press(container, 'r', { ctrlKey: true }).defaultPrevented).toBe(true);
			expect(press(container, 'v', { ctrlKey: true }).defaultPrevented).toBe(true);
			expect(win.keys()).toEqual([]);
		} finally {
			win.stop();
		}
	});

	it('keeps a Ctrl chord Vim owns away from the host hook', () => {
		const onKeyDown = vi.fn(() => true);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		// `<C-e>` scrolls one line down. FilePreview and Auto Run both match the
		// edit/preview toggle with `e.metaKey || e.ctrlKey` from a hook at
		// `Prec.highest`, which runs AHEAD of Vim, so without the gate in
		// `buildEditorExtensions` the physical Ctrl+E flipped the pane out of
		// edit mode. Drop that gate and this is the test that fails.
		press(container, 'e', { ctrlKey: true });
		expect(onKeyDown).not.toHaveBeenCalled();

		// Cmd+E is untouched: the toggle still works, from inside the editor,
		// in Vim mode.
		press(container, 'e', { metaKey: true });
		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].metaKey).toBe(true);
	});

	it('still hands the host every chord Vim does not bind', () => {
		const onKeyDown = vi.fn(() => true);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		// The gate is a table lookup, not "decline all Ctrl". `<C-s>` and `<C-z>`
		// are not Vim bindings (Vim undoes with `u` and redoes with `<C-r>`), so
		// Ctrl+S must still save and Auto Run's Ctrl+Z must still undo.
		press(container, 's', { ctrlKey: true });
		press(container, 'z', { ctrlKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(2);
		expect(onKeyDown.mock.calls.map((c) => c[0].key)).toEqual(['s', 'z']);
	});

	it('asks nothing of the gate in default keyboard mode', () => {
		const onKeyDown = vi.fn(() => true);
		const { container } = mountEditor({ vimMode: false, onKeyDown });
		const win = watchWindow();

		try {
			// `vimEditorOwnsCtrlChord` answers from `getCM(view)`, which is null
			// unless the Vim plugin installed itself, so a user who never turned
			// Vim mode on sees exactly today's behavior on every chord above.
			press(container, 'w', { ctrlKey: true });
			press(container, 'e', { ctrlKey: true });

			expect(onKeyDown).toHaveBeenCalledTimes(2);
		} finally {
			win.stop();
		}
	});
});

/**
 * Escape, which is the collision with a real decision behind it rather than a
 * mechanism: it means "leave insert mode" to CodeMirror and "close the topmost
 * layer" to Maestro, and the layer stack hears it first.
 */
describe('MarkdownEditor - Escape between Vim and the layer stack', () => {
	it("is the editor's while Vim is in insert mode", () => {
		const onKeyDown = vi.fn(() => false);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		press(container, 'i');
		expect(vimEditorAt(contentDom(container))?.mode).toBe('insert');

		const event = press(container, 'Escape');

		// Vim ended insert mode and stopped the key itself, which is what the
		// layer stack declining is for.
		expect(vimEditorOwnsEscape({ target: contentDom(container) })).toBe(false);
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');
		expect(event.defaultPrevented).toBe(true);
	});

	it("is Maestro's while Vim is in normal mode", () => {
		const { container } = mountEditor({ vimMode: true });
		const content = contentDom(container);

		// Escape in normal mode only clears a pending count or operator, and the
		// package explicitly declines it ("we're already in normal mode, let
		// <Esc> be handled normally"). Claiming it would strand the user in a
		// modal whose Escape had quietly stopped working.
		expect(vimEditorOwnsEscape({ target: content })).toBe(false);
		expect(press(container, 'Escape').defaultPrevented).toBe(false);
	});

	it("is the editor's while a visual selection is up", () => {
		const { container, ref } = mountEditor({ vimMode: true, doc: 'alpha beta' });

		act(() => {
			ref.current!.setSelection(0, 0);
		});
		press(container, 'v');
		expect(vimEditorAt(contentDom(container))?.mode).toBe('visual');
		expect(vimEditorOwnsEscape({ target: contentDom(container) })).toBe(true);

		press(container, 'Escape');
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');
	});

	it("is the editor's while a Vim `/` command line is open", () => {
		const { container } = mountEditor({ vimMode: true });

		press(container, '/');

		// The command line is an `<input>` in the editor's panel with its own
		// bubble-phase Escape handler, so it has the same claim insert mode does
		// - and the same problem, since the layer stack runs in capture on
		// `window` and would close the pane out from under a half-typed search.
		const input = container.querySelector('.cm-panels input');
		expect(input).not.toBeNull();
		expect(vimEditorAt(contentDom(container))?.dialogOpen).toBe(true);
		expect(vimEditorOwnsEscape({ target: input })).toBe(true);
	});

	it('answers for a focused editor when the event came from the window', () => {
		const { container } = mountEditor({ vimMode: true });
		contentDom(container).focus();
		press(container, 'i');

		// `LayerStackProvider` listens on `window`, where the target is whatever
		// has focus - but the Vim command line moves focus into its own input
		// while the keydown that opened it still came from the content element.
		// So both are consulted, and an event with no useful target falls back
		// to `document.activeElement`.
		expect(vimEditorOwnsEscape()).toBe(true);
		expect(vimEditorOwnsEscape({ target: document.body })).toBe(true);
	});

	it('answers false for an editor with no Vim on it', () => {
		const { container } = mountEditor({ vimMode: false });
		contentDom(container).focus();

		expect(vimEditorAt(contentDom(container))).toBeNull();
		expect(vimEditorOwnsEscape({ target: contentDom(container) })).toBe(false);
	});
});

/**
 * The same split, end to end through the real `LayerStackProvider`: a modal is
 * open, the caret is in the editor, and Escape has to reach exactly one of them.
 */
describe('MarkdownEditor - Escape with a layer registered', () => {
	function LayerHost({ onEscape }: { onEscape: () => void }) {
		useModalLayer(100, 'Test Layer', onEscape);
		return null;
	}

	function mountWithLayer(vimMode: boolean) {
		useSettingsStore.setState({ keyboardMode: vimMode ? 'vim' : 'default' });
		const onEscape = vi.fn();
		const result = render(
			<LayerStackProvider>
				<LayerHost onEscape={onEscape} />
				<MarkdownEditor value="hello world" onChange={() => {}} language="text" theme={mockTheme} />
			</LayerStackProvider>
		);
		return { ...result, onEscape };
	}

	async function escape(container: HTMLElement) {
		const event = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			contentDom(container).dispatchEvent(event);
		});
		return event;
	}

	it('leaves the modal open when Escape ends insert mode', async () => {
		const { container, onEscape } = mountWithLayer(true);
		press(container, 'i');

		const event = await escape(container);

		// The layer stack declined, Vim acted. Remove the `vimEditorOwnsEscape`
		// guard from `LayerStackContext` and the user loses both: the modal
		// closes AND they are still in insert mode.
		expect(onEscape).not.toHaveBeenCalled();
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');
		expect(event.defaultPrevented).toBe(true);
	});

	it('closes the modal when Escape is pressed in normal mode', async () => {
		const { container, onEscape } = mountWithLayer(true);
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');

		await escape(container);

		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it('closes the modal in default keyboard mode', async () => {
		const { container, onEscape } = mountWithLayer(false);

		await escape(container);

		expect(onEscape).toHaveBeenCalledTimes(1);
	});
});

/**
 * One find bar, one key. Maestro's `Cmd+F` (`filterFiles` and its five
 * surface-scoped siblings in `FIXED_SHORTCUTS`) and the editor's own search are
 * reached by different keys on purpose, and `buildEditorExtensions` omits CM6's
 * `searchKeymap` entirely, so there is no third claimant.
 */
describe('MarkdownEditor - Cmd+F and the editor search', () => {
	it('hands Cmd+F to the host and opens nothing in the editor', () => {
		const onKeyDown = vi.fn(() => true);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		press(container, 'f', { metaKey: true });

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].key).toBe('f');
		// No CM6 search panel and no Vim command line: the host's find bar is
		// the only thing that opened.
		expect(container.querySelector('.cm-panels input')).toBeNull();
		expect(vimEditorAt(contentDom(container))?.dialogOpen).toBe(false);
	});

	it('opens the Vim command line on `/` and leaves the host bar shut', () => {
		const onKeyDown = vi.fn(() => false);
		const { container } = mountEditor({ vimMode: true, onKeyDown });

		const event = press(container, '/');

		expect(container.querySelector('.cm-panels input')).not.toBeNull();
		// Vim claimed the key, so `/` never reaches the surface handler that
		// would have opened the host search bar on a bare slash.
		expect(event.defaultPrevented).toBe(true);
	});
});
