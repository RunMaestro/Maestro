import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '../../../../../renderer/components/FilePreview/markdownEditor/MarkdownEditor';
import type { MarkdownEditorHandle } from '../../../../../renderer/components/FilePreview/markdownEditor/types';
import type { Theme } from '../../../../../renderer/types';

const cmMock = vi.hoisted(() => {
	const makeDoc = (text: string) => {
		const lines = text.split('\n');
		return {
			length: text.length,
			lines: lines.length,
			toString: () => text,
			line(lineNumber: number) {
				const safeLine = Math.min(Math.max(1, lineNumber), lines.length);
				let from = 0;
				for (let i = 0; i < safeLine - 1; i++) from += lines[i].length + 1;
				return { from, number: safeLine };
			},
			lineAt(from: number) {
				let offset = 0;
				for (let i = 0; i < lines.length; i++) {
					const end = offset + lines[i].length;
					if (from <= end) return { from: offset, number: i + 1 };
					offset = end + 1;
				}
				return {
					from: Math.max(0, text.length - (lines.at(-1)?.length ?? 0)),
					number: lines.length,
				};
			},
		};
	};
	return {
		makeDoc,
		views: [] as any[],
		editorStateCreate: vi.fn(),
		editorSelectionSingle: vi.fn((anchor: number, head?: number) => ({ anchor, head })),
		scrollIntoView: vi.fn((pos: number, opts: unknown) => ({ type: 'scrollIntoView', pos, opts })),
		updateListenerOf: vi.fn((fn: unknown) => ({ type: 'updateListener', fn })),
		buildEditorTheme: vi.fn((theme: Theme) => ({ type: 'theme', theme: theme.id })),
		buildEditorExtensions: vi.fn((opts: unknown) => ({ type: 'base', opts })),
		hasLanguageSupport: vi.fn((language: string) => language === 'markdown'),
		loadLanguageExtension: vi.fn(async (language: string) => ({ type: 'language', language })),
		searchHighlightExtension: vi.fn(() => ({ type: 'searchHighlight' })),
		setSearchMatchesEffectOf: vi.fn((value: unknown) => ({ type: 'searchMatches', value })),
	};
});

vi.mock('@codemirror/state', () => {
	class Compartment {
		of(extension: unknown) {
			return { type: 'compartmentOf', compartment: this, extension };
		}
		reconfigure(extension: unknown) {
			return { type: 'reconfigure', compartment: this, extension };
		}
	}
	return {
		Compartment,
		EditorSelection: { single: cmMock.editorSelectionSingle },
		EditorState: {
			create: vi.fn((config: { doc: string; extensions: unknown[] }) => {
				cmMock.editorStateCreate(config);
				return { doc: cmMock.makeDoc(config.doc), extensions: config.extensions };
			}),
		},
	};
});

vi.mock('@codemirror/view', () => {
	class EditorView {
		static updateListener = { of: cmMock.updateListenerOf };
		static scrollIntoView = cmMock.scrollIntoView;
		state: any;
		parent: HTMLElement;
		contentDOM: HTMLElement;
		scrollDOM: HTMLElement;
		dispatches: unknown[] = [];
		destroy = vi.fn();
		private updateListener?: (update: { docChanged: boolean; state: any }) => void;

		constructor(config: { state: any; parent: HTMLElement }) {
			this.state = config.state;
			this.parent = config.parent;
			this.contentDOM = document.createElement('div');
			this.contentDOM.className = 'cm-content';
			this.contentDOM.tabIndex = 0;
			this.scrollDOM = document.createElement('div');
			Object.defineProperty(this.scrollDOM, 'scrollHeight', { configurable: true, value: 1000 });
			Object.defineProperty(this.scrollDOM, 'clientHeight', { configurable: true, value: 250 });
			this.parent.appendChild(this.contentDOM);
			this.updateListener = config.state.extensions.find(
				(ext: { type?: string }) => ext?.type === 'updateListener'
			)?.fn;
			cmMock.views.push(this);
		}

		dispatch(action: any) {
			this.dispatches.push(action);
			if (action?.changes) {
				this.state = {
					...this.state,
					doc: cmMock.makeDoc(action.changes.insert),
				};
				this.updateListener?.({ docChanged: true, state: this.state });
			}
			if (action?.selection) {
				this.state = { ...this.state, selection: action.selection };
			}
		}

		lineBlockAtHeight() {
			return { from: 0 };
		}
	}
	return { EditorView };
});

vi.mock('../../../../../renderer/components/FilePreview/giantPreview/themeAdapter', () => ({
	buildEditorTheme: cmMock.buildEditorTheme,
}));

vi.mock('../../../../../renderer/components/FilePreview/giantPreview/languageLoader', () => ({
	hasLanguageSupport: cmMock.hasLanguageSupport,
	loadLanguageExtension: cmMock.loadLanguageExtension,
}));

vi.mock('../../../../../renderer/components/FilePreview/markdownEditor/extensions', () => ({
	buildEditorExtensions: cmMock.buildEditorExtensions,
}));

vi.mock('../../../../../renderer/components/FilePreview/markdownEditor/searchHighlight', () => ({
	searchHighlightExtension: cmMock.searchHighlightExtension,
	setSearchMatchesEffect: { of: cmMock.setSearchMatchesEffectOf },
}));

const theme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#000',
		bgSidebar: '#111',
		bgActivity: '#222',
		textMain: '#fff',
		textDim: '#aaa',
		accent: '#0af',
		accentForeground: '#fff',
		border: '#333',
		success: '#0f0',
		warning: '#ff0',
		error: '#f00',
	},
} as Theme;

function renderEditor(overrides: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
	const onChange = vi.fn();
	const onKeyDown = vi.fn();
	const onLineNumberContextMenu = vi.fn();
	const ref = React.createRef<MarkdownEditorHandle>();
	const result = render(
		<MarkdownEditor
			ref={ref}
			value={'one\ntwo\nthree'}
			onChange={onChange}
			language="markdown"
			theme={theme}
			onKeyDown={onKeyDown}
			onLineNumberContextMenu={onLineNumberContextMenu}
			{...overrides}
		/>
	);
	return { ...result, ref, onChange, onKeyDown, onLineNumberContextMenu };
}

describe('MarkdownEditor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		cmMock.views.length = 0;
		cmMock.hasLanguageSupport.mockImplementation((language: string) => language === 'markdown');
		cmMock.loadLanguageExtension.mockResolvedValue({ type: 'language', language: 'markdown' });
	});

	it('mounts CodeMirror, forwards document changes, and destroys the view on unmount', async () => {
		const { ref, onChange, onKeyDown, onLineNumberContextMenu, unmount, getByTestId } =
			renderEditor({
				className: 'custom-editor',
			});
		const root = getByTestId('markdown-editor-root');
		expect(root.className).toContain('custom-editor');
		expect(cmMock.views).toHaveLength(1);
		expect(ref.current?.getContentEl()).toBe(cmMock.views[0].contentDOM);
		await waitFor(() => {
			expect(cmMock.views[0].dispatches).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						effects: expect.objectContaining({
							extension: { type: 'language', language: 'markdown' },
						}),
					}),
				])
			);
		});

		const baseOptions = cmMock.buildEditorExtensions.mock.calls[0][0];
		const menuEvent = new MouseEvent('contextmenu');
		baseOptions.onGutterContextMenu(4, menuEvent);
		baseOptions.onKeyDown(new KeyboardEvent('keydown', { key: 's' }));
		expect(onLineNumberContextMenu).toHaveBeenCalledWith(4, menuEvent);
		expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 's' }));

		const updateListener = cmMock.updateListenerOf.mock.calls[0][0];
		updateListener({ docChanged: false, state: cmMock.views[0].state });
		expect(onChange).not.toHaveBeenCalled();

		act(() => {
			cmMock.views[0].dispatch({ changes: { from: 0, to: 13, insert: 'changed' } });
		});
		expect(onChange).toHaveBeenCalledWith('changed');

		unmount();
		expect(cmMock.views[0].destroy).toHaveBeenCalled();
	});

	it('applies external value, theme, language, and base option updates without echoing onChange', async () => {
		const { rerender, onChange } = renderEditor();
		const view = cmMock.views[0];
		onChange.mockClear();

		rerender(
			<MarkdownEditor
				value="external"
				onChange={onChange}
				language="plaintext"
				theme={{ ...theme, id: 'light' }}
				spellCheck
				wrap={false}
				showLineNumbers={false}
			/>
		);

		expect(view.state.doc.toString()).toBe('external');
		expect(onChange).not.toHaveBeenCalled();
		expect(cmMock.buildEditorTheme).toHaveBeenCalledWith(expect.objectContaining({ id: 'light' }));
		expect(cmMock.buildEditorExtensions).toHaveBeenCalledWith(
			expect.objectContaining({ wrap: false, showLineNumbers: false, spellCheck: true })
		);
		const latestBaseOptions = cmMock.buildEditorExtensions.mock.calls.at(-1)[0];
		expect(() => {
			latestBaseOptions.onGutterContextMenu(1, new MouseEvent('contextmenu'));
			latestBaseOptions.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
		}).not.toThrow();
		expect(view.dispatches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ effects: expect.objectContaining({ type: 'reconfigure' }) }),
			])
		);
	});

	it('loads supported languages and ignores cancelled async language loads', async () => {
		let resolveLanguage: (extension: unknown) => void = () => {};
		cmMock.loadLanguageExtension.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLanguage = resolve;
			})
		);
		const { unmount } = renderEditor();
		const view = cmMock.views[0];
		unmount();

		await act(async () => {
			resolveLanguage({ type: 'language', language: 'markdown' });
			await Promise.resolve();
		});

		expect(view.dispatches).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					effects: expect.objectContaining({
						extension: { type: 'language', language: 'markdown' },
					}),
				}),
			])
		);
	});

	it('skips mount-time language loading when the language is unsupported', () => {
		renderEditor({ language: 'plaintext' });
		expect(cmMock.hasLanguageSupport).toHaveBeenCalledWith('plaintext');
		expect(cmMock.loadLanguageExtension).not.toHaveBeenCalled();
	});

	it('exposes imperative editor helpers', () => {
		const { ref, unmount } = renderEditor();
		const view = cmMock.views[0];
		const handle = ref.current!;

		handle.focus();
		expect(document.activeElement).toBe(view.contentDOM);

		handle.scrollToLine(2);
		expect(cmMock.editorSelectionSingle).toHaveBeenCalledWith(4);
		expect(cmMock.scrollIntoView).toHaveBeenCalledWith(4, {
			y: 'start',
			yMargin: 80,
		});

		handle.scrollToLine(99, { select: false });
		expect(cmMock.scrollIntoView).toHaveBeenCalledWith(expect.any(Number), {
			y: 'start',
			yMargin: 0,
		});

		expect(handle.getTopLine()).toBe(1);
		view.scrollDOM.scrollTop = 375;
		expect(handle.getScrollPercent()).toBe(0.5);
		Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: 250 });
		expect(handle.getScrollPercent()).toBe(0);
		Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: 1000 });
		handle.setScrollPercent(2);
		expect(view.scrollDOM.scrollTop).toBe(750);

		handle.setSelection(-10, 999, true);
		expect(cmMock.editorSelectionSingle).toHaveBeenCalledWith(0, view.state.doc.length);
		expect(cmMock.scrollIntoView).toHaveBeenCalledWith(0, { y: 'center' });
		handle.setSelection(1, 2);
		expect(cmMock.editorSelectionSingle).toHaveBeenCalledWith(1, 2);

		handle.setSearchMatches([{ from: 0, to: 3 }], 0);
		expect(cmMock.setSearchMatchesEffectOf).toHaveBeenCalledWith({
			matches: [{ from: 0, to: 3 }],
			currentIndex: 0,
		});

		unmount();
		expect(() => {
			handle.focus();
			handle.scrollToLine(1);
			expect(handle.getTopLine()).toBe(1);
			expect(handle.getScrollPercent()).toBe(0);
			handle.setScrollPercent(0.5);
			handle.setSelection(0, 1);
			handle.setSearchMatches([], 0);
			expect(handle.getContentEl()).toBeNull();
		}).not.toThrow();
	});
});
