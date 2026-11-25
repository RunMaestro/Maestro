import { createRef, useRef, useState } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { useFilePreviewSearch } from '../../../../renderer/hooks/file/useFilePreviewSearch';
import {
	MarkdownEditor,
	type MarkdownEditorHandle,
} from '../../../../renderer/components/FilePreview/markdownEditor';
import { mockTheme } from '../../../helpers/mockTheme';

// The real search caller and real CM view share a controlled value, as in FilePreview.
// A raw-string replacement fake cannot reproduce CM's CRLF -> LF coordinates.
function renderSearchEditor(
	source: string,
	opts: { editable?: boolean; mode?: 'text' | 'jq' } = {}
) {
	const editor = createRef<MarkdownEditorHandle>();
	const changed = vi.fn();
	let search!: ReturnType<typeof useFilePreviewSearch>;
	function SearchEditor() {
		const [text, setText] = useState(source);
		const container = useRef<HTMLDivElement>(null);
		search = useFilePreviewSearch({
			codeContainerRef: container,
			markdownContainerRef: container,
			contentRef: container,
			editorRef: editor,
			isMarkdown: false,
			isImage: false,
			isCsv: false,
			isJsonl: false,
			isJson: false,
			isEditableText: opts.editable ?? true,
			markdownEditMode: true,
			editContent: text,
			fileContent: source,
			searchMode: opts.mode ?? 'text',
			supportsLineSearch: true,
		});
		return (
			<div ref={container}>
				<MarkdownEditor
					ref={editor}
					value={text}
					onChange={(next) => {
						changed(next);
						setText(next);
					}}
					readOnly={opts.editable === false}
					language="text"
					theme={mockTheme}
				/>
			</div>
		);
	}
	const mounted = render(<SearchEditor />);
	const view = () => EditorView.findFromDOM(editor.current!.getContentEl()!)!;
	return { changed, search: () => search, view, ...mounted };
}

describe('search replacement through the real editor', () => {
	it.each(['\n', '\r\n', '\r'])(
		'Replace uses editor coordinates after %j without rewriting on open',
		(eol) => {
			const raw = `a${eol}foo`;
			const host = renderSearchEditor(raw);
			expect(host.changed).not.toHaveBeenCalled();
			act(() => host.search().setSearchQuery('foo'));
			expect(host.search().totalMatches).toBe(1);
			act(() => expect(host.search().replaceCurrent('X')).toBe(true));
			expect(host.view().state.doc.toString()).toBe('a\nX');
			expect(host.changed).toHaveBeenLastCalledWith('a\nX');
			host.unmount();
		}
	);

	it('Replace All spans later CRLF lines and UTF-16 text in one undoable editor transaction', () => {
		const raw = '🌍\r\nfoo\r\nfoo fin\r\nfoo';
		const host = renderSearchEditor(raw);
		expect(host.changed).not.toHaveBeenCalled();
		act(() => host.search().setSearchQuery('foo'));
		expect(host.search().totalMatches).toBe(3);
		act(() => expect(host.search().replaceAll('X')).toBe(3));
		expect(host.view().state.doc.toString()).toBe('🌍\nX\nX fin\nX');
		expect(host.changed).toHaveBeenCalledTimes(1);
		const view = host.view();
		act(() => expect(undo(view)).toBe(true));
		expect(host.view().state.doc.toString()).toBe('🌍\nfoo\nfoo fin\nfoo');
		host.unmount();
	});

	it('uses normalized multiline regex captures at the same real editor boundary', () => {
		const host = renderSearchEditor('🌍\r\nfoo 1\r\nfoo 2');
		act(() => {
			host.search().setSearchKind('regex');
			host.search().setSearchQuery('foo (\\d)\\nfoo (\\d)');
		});
		expect(host.search().totalMatches).toBe(1);
		act(() => expect(host.search().replaceAll('$2:$1')).toBe(1));
		expect(host.view().state.doc.toString()).toBe('🌍\n2:1');
		host.unmount();
	});

	it.each([{ editable: false }, { mode: 'jq' as const }])(
		'refuses replacement outside editable text mode: %j',
		(opts) => {
			const raw = 'a\r\nfoo';
			const host = renderSearchEditor(raw, opts);
			act(() => host.search().setSearchQuery('foo'));
			expect(host.search().canReplace).toBe(false);
			act(() => {
				expect(host.search().replaceCurrent('X')).toBe(false);
				expect(host.search().replaceAll('X')).toBe(0);
			});
			expect(host.view().state.doc.toString()).toBe('a\nfoo');
			expect(host.changed).not.toHaveBeenCalled();
			host.unmount();
		}
	);
});
