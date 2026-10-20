/**
 * The chat composer stays a plain `<textarea>` in Vim mode.
 *
 * Phase 06 gave the markdown editor real Vim keys and deliberately left the
 * composer out (the reasoning is in the docblock on `InputTextarea`). An
 * omission that nothing tests is indistinguishable from an omission nobody got
 * round to, so these pin the three halves of it:
 *
 *  1. There is no editor here, and no module under `InputArea/` reaches for
 *     one. The source scan is what catches the "wire Vim into the composer
 *     too" change that a render assertion would pass straight through.
 *  2. Every carve-out the Vim editor asked for declines on the composer,
 *     because all of them resolve through `.cm-editor`. That is what keeps
 *     Escape, Ctrl+W and friends behaving exactly as they did before.
 *  3. The one Vim affordance the composer DOES keep, the `jk` escape, still
 *     applies to the real composer node - and the behaviors the composer
 *     already had are identical in both keyboard modes.
 *
 * The `jk` wiring through the real keydown listener is covered in
 * `useMainKeyboardHandler.test.ts`; what is new here is that the REAL composer
 * node satisfies the gate those tests exercise against a synthetic textarea.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { InputArea } from '../../../../renderer/components/InputArea';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	vimEditorOwnsEscape,
	vimEditorOwnsCtrlChord,
	VIM_EDITOR_CTRL_BINDINGS,
} from '../../../../renderer/components/FilePreview/markdownEditor/vimKeys';
import {
	applyInsertEscape,
	insertEscapeTarget,
	parseInsertEscapeSequence,
} from '../../../../renderer/utils/vimInsertEscape';
import {
	isNormalMode,
	isTextEntryTarget,
	TEXT_ENTRY_SURFACE_SELECTOR,
} from '../../../../renderer/utils/messageScrollNavigation';
import { vimKeysExtension } from '../../../../renderer/components/FilePreview/markdownEditor/vimKeys';
import { useTemplateAutocomplete } from '../../../../renderer/hooks/input/useTemplateAutocomplete';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../../../renderer/utils/textareaSizing';
import { createInputAreaSession, inputAreaTheme } from './_fixtures';

const REPO_ROOT = path.join(__dirname, '../../../../..');
const COMPOSER_DIR = path.join(REPO_ROOT, 'src/renderer/components/InputArea');

type ComposerProps = Parameters<typeof InputArea>[0];

// CM6's DOMObserver constructs an IntersectionObserver, and the shared setup
// leaves that global a non-constructable `vi.fn()`. Needed only by the positive
// control below, which mounts a real view (same dance as GiantPreview.test.tsx).
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

/**
 * A real Vim-enabled CodeMirror view, as the POSITIVE control for the
 * carve-outs below.
 *
 * Without it, "the predicate said false for the composer" is a sentence a
 * predicate hard-wired to false would also satisfy. This gives the same two
 * predicates a node they must answer true for, in the same test, so a false on
 * the composer means the composer and not the function.
 */
let controlEditor: { view: EditorView; parent: HTMLElement } | null = null;

function mountVimEditor(): { host: HTMLElement; content: HTMLElement } {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const view = new EditorView({
		state: EditorState.create({ doc: 'hello world', extensions: [vimKeysExtension(true)] }),
		parent,
	});
	// Torn down in `afterEach` rather than at the end of the test: CM6's
	// contenteditable is also a `textbox`, so a control left behind by a failing
	// assertion would break `getByRole` in every test after it.
	controlEditor = { view, parent };
	return { host: view.dom, content: view.contentDOM };
}

function destroyVimEditor(): void {
	controlEditor?.view.destroy();
	controlEditor?.parent.remove();
	controlEditor = null;
}

/**
 * Render the real composer in the given keyboard mode.
 *
 * Deliberately the whole `InputArea` rather than `InputTextarea` alone: the
 * question is whether a CodeMirror editor exists anywhere in the composer's
 * subtree, and only the full tree can answer it.
 */
function renderComposer(
	overrides: Partial<ComposerProps> & {
		vimMode?: boolean;
		inputValue?: string;
		commandMode?: 'off' | 'shell' | 'ai';
	} = {}
) {
	const { vimMode = true, inputValue = '', commandMode = 'off', ...rest } = overrides;
	useSettingsStore.setState({ keyboardMode: vimMode ? 'vim' : 'default' });
	useComposerInputStore.setState({
		aiValue: inputValue,
		terminalValue: inputValue,
		aiCommandMode: commandMode,
	});

	const inputRef = { current: null } as React.RefObject<HTMLTextAreaElement>;
	// The real `setInputValue` writes the draft store the composer renders from,
	// so a spy that only records would leave the controlled value snapping back
	// and hide whether an edit actually landed.
	const setInputValue = vi.fn((value: string) => {
		useComposerInputStore.setState({ aiValue: value });
	});
	const props = {
		session: createInputAreaSession({ inputMode: 'ai' }),
		theme: inputAreaTheme,
		setInputValue,
		enterToSend: true,
		setEnterToSend: vi.fn(),
		stagedImages: [],
		setStagedImages: vi.fn(),
		setLightboxImage: vi.fn(),
		commandHistoryOpen: false,
		setCommandHistoryOpen: vi.fn(),
		commandHistoryFilter: '',
		setCommandHistoryFilter: vi.fn(),
		commandHistorySelectedIndex: 0,
		setCommandHistorySelectedIndex: vi.fn(),
		slashCommandOpen: false,
		setSlashCommandOpen: vi.fn(),
		slashCommands: [],
		selectedSlashCommandIndex: 0,
		setSelectedSlashCommandIndex: vi.fn(),
		inputRef,
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
		toggleInputMode: vi.fn(),
		processInput: vi.fn(),
		handleInterrupt: vi.fn(),
		onInputFocus: vi.fn(),
		onInputBlur: vi.fn(),
		...rest,
	} as unknown as ComposerProps;

	const view = render(<InputArea {...props} />);
	return {
		...view,
		setInputValue,
		textarea: screen.getByRole('textbox') as HTMLTextAreaElement,
	};
}

/**
 * Module specifiers a composer source file imports from.
 *
 * Specifiers rather than whole-file text: `InputTextarea`'s docblock NAMES the
 * editor and the package on purpose (that is where the omission is explained),
 * so a substring scan would flag the very comment that records the decision.
 */
function importedModules(source: string): string[] {
	return Array.from(source.matchAll(/\bfrom\s+'([^']+)'|\brequire\('([^']+)'\)/g)).map(
		(match) => match[1] ?? match[2]
	);
}

/** Every `.ts` / `.tsx` file the composer is built out of. */
function composerSourceFiles(dir: string = COMPOSER_DIR): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return composerSourceFiles(full);
		return /\.tsx?$/.test(entry.name) ? [full] : [];
	});
}

describe('the chat composer is untouched by Vim editing', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [], groups: [] });
	});

	afterEach(() => {
		destroyVimEditor();
		useSettingsStore.setState({ keyboardMode: 'default' });
		vi.restoreAllMocks();
	});

	describe('no editor, and nothing reaching for one', () => {
		it('renders a plain textarea and no CodeMirror editor in Vim mode', () => {
			const { container, textarea } = renderComposer({ vimMode: true });

			expect(textarea.tagName).toBe('TEXTAREA');
			// `.cm-editor` is the wrapper every carve-out keys on, `.cm-content`
			// the contenteditable Vim would own. Neither exists in the composer.
			expect(container.querySelector('.cm-editor')).toBeNull();
			expect(container.querySelector('.cm-content')).toBeNull();
			expect(container.querySelector('[contenteditable]')).toBeNull();
		});

		it('renders the same plain textarea in default mode, so the mode changes nothing', () => {
			const vim = renderComposer({ vimMode: true, inputValue: 'hello' });
			const vimHtml = vim.textarea.outerHTML;
			vim.unmount();

			const plain = renderComposer({ vimMode: false, inputValue: 'hello' });

			expect(plain.textarea.outerHTML).toBe(vimHtml);
		});

		it('has no module under InputArea/ that imports CodeMirror or the Vim gate', () => {
			const files = composerSourceFiles();
			// Sanity: a glob that silently matched nothing would pass vacuously.
			expect(files.length).toBeGreaterThan(20);

			const offenders = files
				.flatMap((file) =>
					importedModules(readFileSync(file, 'utf8')).map((specifier) => ({ file, specifier }))
				)
				.filter(({ specifier }) => /codemirror|markdownEditor|vimKeys/i.test(specifier))
				.map(({ file, specifier }) => `${path.relative(REPO_ROOT, file)} -> ${specifier}`);

			expect(offenders).toEqual([]);
		});
	});

	describe("the Vim editor's carve-outs decline on the composer", () => {
		it('leaves Escape to the layer stack and to the composer itself', () => {
			const { textarea } = renderComposer({ vimMode: true });
			const editor = mountVimEditor();
			textarea.focus();

			// Both readings the predicate takes: the event's own target, and (for a
			// window-level listener, where the target is <body>) whatever has focus.
			expect(vimEditorOwnsEscape({ target: textarea })).toBe(false);
			expect(vimEditorOwnsEscape({ target: document.body })).toBe(false);
			expect(vimEditorOwnsEscape()).toBe(false);

			// The control: the same predicate, mid-insert, on a real Vim editor.
			act(() => {
				editor.content.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
				);
			});
			expect(vimEditorOwnsEscape({ target: editor.content })).toBe(true);
		});

		it('leaves every Vim Ctrl chord to Maestro while focus is in the composer', () => {
			const { textarea } = renderComposer({ vimMode: true });
			const editor = mountVimEditor();
			textarea.focus();

			const ownedBy = (node: EventTarget) =>
				VIM_EDITOR_CTRL_BINDINGS.filter((binding) =>
					vimEditorOwnsCtrlChord({
						target: node,
						ctrlKey: true,
						metaKey: false,
						key: binding.eventKey,
					})
				).map((binding) => binding.keys.join('+'));

			// Every chord in the table, not just the colliding ones: Ctrl+W must
			// still close the tab and Ctrl+O must still open the agent switcher
			// from the composer.
			expect(VIM_EDITOR_CTRL_BINDINGS.length).toBeGreaterThan(0);
			expect(ownedBy(textarea)).toEqual([]);

			// The control: inside a real Vim editor the same chords ARE claimed, so
			// the empty list above is a fact about the composer and not about the
			// predicate. The editor mounts in normal mode, so the comparison is the
			// normal-mode subset (`Ctrl+T` is an insert-mode binding).
			const normalModeChords = VIM_EDITOR_CTRL_BINDINGS.filter((binding) =>
				binding.modes.includes('normal')
			).map((binding) => binding.keys.join('+'));
			expect(normalModeChords.length).toBeGreaterThan(0);
			expect(ownedBy(editor.content)).toEqual(normalModeChords);
		});
	});

	describe('the one Vim affordance it keeps: the jk escape', () => {
		it('is a field jk may act on, unlike an editor or a terminal', () => {
			const { textarea } = renderComposer({ vimMode: true });
			textarea.focus();

			expect(insertEscapeTarget(textarea)).toBe(textarea);
			// The flip side of the same selector: `jk` is allowed here precisely
			// because the composer is NOT one of the surfaces it subtracts.
			expect(textarea.closest(TEXT_ENTRY_SURFACE_SELECTOR)).toBeNull();
		});

		it('retracts the j, blurs the composer, and lets React see the spliced draft', () => {
			const { textarea, setInputValue } = renderComposer({
				vimMode: true,
				inputValue: 'ship it j',
			});
			textarea.focus();
			textarea.setSelectionRange(9, 9);
			setInputValue.mockClear();

			let retracted = false;
			act(() => {
				retracted = applyInsertEscape(textarea, parseJkBinding().inserted);
			});

			expect(retracted).toBe(true);
			expect(textarea.value).toBe('ship it ');
			expect(document.activeElement).not.toBe(textarea);
			// The retraction dispatches a real `input` event, so the composer's own
			// onChange runs and the draft store is told - not just the DOM node.
			expect(setInputValue).toHaveBeenCalledWith('ship it ');
		});

		it('does not act on the composer while an AI command proposal owns the keys', () => {
			// `awaitingAiCommand` makes the textarea readOnly: every key answers the
			// proposal, and there is no typed `j` to take back.
			const { textarea } = renderComposer({ vimMode: true, inputValue: 'j' });
			textarea.readOnly = true;
			textarea.focus();

			expect(insertEscapeTarget(textarea)).toBeNull();
		});
	});

	describe('Vim-mode normal keys stay out of the composer', () => {
		it('counts the composer as text entry, so g g and h do not fire actions', () => {
			const { textarea } = renderComposer({ vimMode: true });
			textarea.focus();

			expect(isTextEntryTarget(textarea)).toBe(true);
			// `isNormalMode` is the gate the sequence matcher runs: false here means
			// a bare `h` or a `g g` is a character, not a Maestro command.
			expect(isNormalMode({ target: textarea })).toBe(false);
			// The window-listener reading, where the target is <body> and only
			// `document.activeElement` names the composer.
			expect(isNormalMode({ target: document.body })).toBe(false);
		});
	});

	describe('the behaviors the composer already had, in Vim mode', () => {
		it('still autosizes to its content, to the same height as in default mode', () => {
			const contentHeight = 84;
			const scrollHeight = vi
				.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
				.mockReturnValue(contentHeight);

			const vim = renderComposer({ vimMode: true, inputValue: 'line one\nline two\nline three' });
			const vimHeight = vim.textarea.style.height;
			vim.unmount();

			const plain = renderComposer({
				vimMode: false,
				inputValue: 'line one\nline two\nline three',
			});

			expect(vimHeight).toBe(`${contentHeight}px`);
			expect(plain.textarea.style.height).toBe(vimHeight);
			expect(contentHeight).toBeLessThan(KEYSTROKE_TEXTAREA_MAX_HEIGHT);
			scrollHeight.mockRestore();
		});

		it('still climbs the bang ladder when a ! is typed into an empty draft', () => {
			const { textarea } = renderComposer({ vimMode: true, inputValue: '', commandMode: 'off' });

			fireEvent.change(textarea, { target: { value: '!' } });

			// The bang is consumed on entry, so command mode is the whole readout.
			expect(useComposerInputStore.getState().aiCommandMode).toBe('shell');
			expect(screen.getByText('Command Mode')).toBeInTheDocument();
		});

		it('still shows Tab completion for a command-mode draft', () => {
			renderComposer({
				vimMode: true,
				inputValue: 'git checkout ma',
				commandMode: 'shell',
				tabCompletionOpen: true,
				tabCompletionSuggestions: [
					{ value: 'git checkout main', type: 'branch', displayText: 'main' },
				],
				setTabCompletionFilter: vi.fn(),
			} as Partial<ComposerProps> & { vimMode: boolean });

			expect(screen.getByText('Tab Completion')).toBeInTheDocument();
			expect(screen.getByText('main')).toBeInTheDocument();
		});

		it('still opens the {{template}} autocomplete over a plain textarea', () => {
			// The textarea binding of the shared engine - the composer family's
			// autocomplete, as opposed to `useEditorTemplateAutocomplete`, which is
			// the CodeMirror one Vim now sits in front of.
			useSettingsStore.setState({ keyboardMode: 'vim' });
			const textarea = document.createElement('textarea');
			document.body.appendChild(textarea);
			const textareaRef = { current: textarea } as React.RefObject<HTMLTextAreaElement>;

			const { result } = renderHook(() =>
				useTemplateAutocomplete({ textareaRef, value: '', onChange: vi.fn() })
			);

			textarea.value = '{{';
			textarea.setSelectionRange(2, 2);
			act(() => {
				result.current.handleChange({
					target: textarea,
				} as unknown as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
			textarea.remove();
		});
	});
});

/** The shipped `jk` binding, or a loud failure if the default ever stops parsing. */
function parseJkBinding() {
	const binding = parseInsertEscapeSequence('jk');
	if (!binding) throw new Error('the default jk sequence no longer parses');
	return binding;
}
