// Source: src/__tests__/renderer/components/FilePreview/MarkdownImage.test.tsx
// Source: src/__tests__/renderer/components/FilePreview/markdownEditorCodeEditing.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownEditorExtensions.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { MarkdownImage } from '../../../../renderer/components/FilePreview/MarkdownImage';
import { imageCache } from '../../../../renderer/components/FilePreview/filePreviewUtils';
import { mockTheme } from '../../../helpers/mockTheme';
import { beforeAll } from 'vitest';
import { afterAll } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { keymap } from '@codemirror/view';
import type { KeyBinding } from '@codemirror/view';
import { completeAnyWord } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { buildEditorExtensions } from '../../../../renderer/components/FilePreview/markdownEditor/extensions';
import { mainSelectionDetails } from '../../../../renderer/components/FilePreview/markdownEditor/extensions';
import { APP_OWNED_EDITOR_CHORDS } from '../../../../renderer/components/FilePreview/markdownEditor/codeEditing';
import { CODE_EDITOR_SHORTCUT_IDS } from '../../../../renderer/components/FilePreview/markdownEditor/codeEditing';
import { editorClaimsKey } from '../../../../renderer/components/FilePreview/markdownEditor/codeEditing';
import { withoutAppOwnedChords } from '../../../../renderer/components/FilePreview/markdownEditor/codeEditing';
import type { BuildCodeEditingExtensionsOptions } from '../../../../renderer/components/FilePreview/markdownEditor/codeEditing';
import { FIXED_SHORTCUTS } from '../../../../renderer/constants/shortcuts';
describeSourceSuite('MarkdownImage', () => {
	const readFile = vi.mocked(window.maestro.fs.readFile);
	const stat = vi.mocked(window.maestro.fs.stat);

	describe('MarkdownImage', () => {
		beforeEach(() => {
			imageCache.clear();
			readFile.mockReset();
			stat.mockReset();
		});

		it('loads a vault-root image after the note-relative reading misses', async () => {
			readFile.mockImplementation(async (path: string) =>
				path === '/vault/Body/_attachments/a b.jpg' ? 'data:image/jpeg;base64,AAAA' : null
			);
			render(
				<MarkdownImage
					src="Body/_attachments/a%20b.jpg"
					alt="Caption|220"
					markdownFilePath="/vault/Body/note.md"
					projectRoot="/vault"
					theme={mockTheme}
				/>
			);

			const img = await screen.findByAltText('Caption');
			expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
			expect(img.style.width).toBe('220px');
			expect(readFile).toHaveBeenNthCalledWith(
				1,
				'/vault/Body/Body/_attachments/a b.jpg',
				undefined
			);
		});

		it('says the image is missing instead of calling it invalid', async () => {
			readFile.mockResolvedValue(null);
			render(
				<MarkdownImage
					src="missing.png"
					markdownFilePath="/vault/note.md"
					projectRoot="/vault"
					theme={mockTheme}
				/>
			);
			expect(await screen.findByText('Image not found: missing.png')).toBeTruthy();
		});

		it('renders media as a chip that opens the resolved file', async () => {
			stat.mockImplementation(async (path: string) => {
				if (path === '/vault/clip.mp4') return { size: 1 } as any;
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			});
			const onOpenFile = vi.fn();
			render(
				<MarkdownImage
					src="clip.mp4"
					alt="Demo clip"
					markdownFilePath="/vault/Body/note.md"
					projectRoot="/vault"
					onOpenFile={onOpenFile}
					theme={mockTheme}
				/>
			);

			const chip = await screen.findByRole('button', { name: /Demo clip/ });
			await waitFor(() => expect(chip.hasAttribute('disabled')).toBe(false));
			fireEvent.click(chip);
			expect(onOpenFile).toHaveBeenCalledWith('/vault/clip.mp4');
			expect(readFile).not.toHaveBeenCalled();
		});

		it('marks a media embed that resolves nowhere as not found', async () => {
			stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
			render(<MarkdownImage src="gone.mp3" markdownFilePath="/vault/note.md" theme={mockTheme} />);
			expect(await screen.findByText('Not found: gone.mp3')).toBeTruthy();
		});
	});
});
describeSourceSuite('markdownEditorCodeEditing', () => {
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
			mainSelectionDetails(
				EditorState.create({ doc, selection: EditorSelection.single(from, to) })
			);

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
});
describeSourceSuite('markdownEditorExtensions', () => {
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

	/**
	 * A paste of plain text. jsdom has no `ClipboardEvent` constructor with a
	 * working `clipboardData`, so the event is built by hand and the payload is
	 * attached to it - which is all CodeMirror's own paste handler reads.
	 */
	function paste(view: EditorView, text: string): Event {
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', {
			value: { getData: () => text, types: ['text/plain'], items: [], files: [] },
		});
		view.contentDOM.dispatchEvent(event);
		return event;
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

	/**
	 * The paste-side twin of the keydown seam, and the reason it has to exist:
	 * CodeMirror's own paste handler inserts the clipboard text and stops the
	 * chain, so a host that wants to REWRITE a paste (Auto Run trims stray
	 * whitespace, and turns a clipboard image into a saved attachment) has to see
	 * the event first.
	 *
	 * The failure this guards against is silent and doubles text: if `onPaste` ran
	 * at normal precedence, or its `true` were ignored, the host would insert its
	 * rewritten text AND CodeMirror would insert the raw clipboard text after it.
	 */
	describe('buildEditorExtensions - host paste', () => {
		it('lets the editor keep a paste the host declines', () => {
			const onPaste = vi.fn(() => undefined);
			const view = mountWith({ onPaste });

			paste(view, 'world');

			expect(onPaste).toHaveBeenCalledTimes(1);
			// Declining leaves the insert to CodeMirror, which is the behaviour every
			// surface that only WATCHES pastes depends on.
			expect(view.state.doc.toString()).toBe('worldhello');
			view.destroy();
		});

		it('swallows a paste the host claims by returning true', () => {
			const onPaste = vi.fn(() => true);
			const view = mountWith({ onPaste });

			paste(view, 'world');

			expect(onPaste).toHaveBeenCalledTimes(1);
			// Document untouched: the host ran at Prec.highest and consumed the event,
			// so it is free to insert its own rewritten text without doubling up.
			expect(view.state.doc.toString()).toBe('hello');
			view.destroy();
		});

		it('behaves exactly as before when no host handler is supplied', () => {
			const view = mountWith({});

			paste(view, 'world');

			expect(view.state.doc.toString()).toBe('worldhello');
			view.destroy();
		});
	});

	describe('buildEditorExtensions - placeholder', () => {
		it('paints the hint while the document is empty', () => {
			const parent = document.createElement('div');
			document.body.appendChild(parent);
			const view = new EditorView({
				state: EditorState.create({
					doc: '',
					extensions: buildEditorExtensions({
						wrap: true,
						showLineNumbers: false,
						spellCheck: false,
						placeholder: 'Capture notes here',
					}),
				}),
				parent,
			});

			expect(view.dom.textContent).toContain('Capture notes here');
			view.destroy();
		});

		it('adds no placeholder widget when none is configured', () => {
			const parent = document.createElement('div');
			document.body.appendChild(parent);
			const view = new EditorView({
				state: EditorState.create({
					doc: '',
					extensions: buildEditorExtensions({
						wrap: true,
						showLineNumbers: false,
						spellCheck: false,
					}),
				}),
				parent,
			});

			expect(view.dom.querySelector('.cm-placeholder')).toBeNull();
			view.destroy();
		});
	});
});
