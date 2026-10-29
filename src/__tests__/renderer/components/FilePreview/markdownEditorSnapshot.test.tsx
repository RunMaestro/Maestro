import { createRef } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
	MarkdownEditor,
	type MarkdownEditorHandle,
} from '../../../../renderer/components/FilePreview/markdownEditor';
import { captureEditorSnapshot } from '../../../../renderer/components/FilePreview/markdownEditor/snapshot';
import { mockTheme } from '../../../helpers/mockTheme';

describe('editor snapshots', () => {
	it.each(['a\nb\n🌍 fin', 'a\r\nb\r\n🌍 fin', 'a\r\nb\n🌍 fin', 'a\rb\r🌍 fin'])(
		'keeps exact line endings and maps UTF-16 offsets: %j',
		(text) => {
			const state = EditorState.create({ doc: text, selection: EditorSelection.single(4, 6) });
			const before = state.doc.toString();
			const snapshot = captureEditorSnapshot(state, text);
			expect(snapshot.text).toBe(text);
			expect(snapshot.selection).toEqual({
				start: text.indexOf('🌍'),
				end: text.indexOf('🌍') + 2,
			});
			expect(snapshot.text.slice(snapshot.selection.start, snapshot.selection.end)).toBe('🌍');
			expect(state.doc.toString()).toBe(before);
		}
	);
	it.each([
		[1, 2],
		[2, 3],
	])('rejects a half surrogate selection %j..%j', (anchor, head) => {
		const state = EditorState.create({ doc: 'a🌍b', selection: { anchor, head } });
		expect(() => captureEditorSnapshot(state, 'a🌍b')).toThrow('surrogate pair');
	});
	it('rejects unavailable and mismatched states instead of expanding selection', () => {
		expect(() => captureEditorSnapshot(null, 'text')).toThrow('unavailable');
		expect(() => captureEditorSnapshot(EditorState.create({ doc: 'new' }), 'old')).toThrow('stale');
	});
	it('preserves an empty document and a caret', () => {
		expect(captureEditorSnapshot(EditorState.create(), '')).toEqual({
			text: '',
			selection: { start: 0, end: 0 },
		});
	});
	it('maps reversed selection and end-of-document caret across CRLF', () => {
		const text = 'a\r\n🌍';
		const state = EditorState.create({ doc: text, selection: { anchor: 4, head: 2 } });
		expect(captureEditorSnapshot(state, text).selection).toEqual({ start: 3, end: 5 });
		const caret = state.update({ selection: { anchor: 4 } }).state;
		expect(captureEditorSnapshot(caret, text).selection).toEqual({ start: 5, end: 5 });
	});
	it('keeps a captured snapshot detached from subsequent transactions', () => {
		const state = EditorState.create({ doc: 'old\r\n🌍', selection: { anchor: 4, head: 6 } });
		const snapshot = captureEditorSnapshot(state, 'old\r\n🌍');
		const next = state.update({ changes: { from: 0, to: 3, insert: 'new' } }).state;
		expect(captureEditorSnapshot(next, 'new\r\n🌍').text).toBe('new\r\n🌍');
		expect(snapshot).toEqual({ text: 'old\r\n🌍', selection: { start: 5, end: 7 } });
	});
	it('captures current edits before a controlled parent echoes them back', () => {
		const ref = createRef<MarkdownEditorHandle>();
		const onChange = vi.fn();
		const source = 'a\r\n🌍';
		const { unmount } = render(
			<MarkdownEditor
				ref={ref}
				value={source}
				onChange={onChange}
				language="text"
				theme={mockTheme}
			/>
		);
		act(() => ref.current!.setSelection(2, 4));
		expect(ref.current!.getSnapshot()).toEqual({ text: source, selection: { start: 3, end: 5 } });
		expect(onChange).not.toHaveBeenCalled();
		act(() => ref.current!.replaceRange(2, 4, 'ok'));
		expect(onChange).toHaveBeenLastCalledWith('a\nok');
		expect(ref.current!.getSnapshot()).toEqual({ text: 'a\nok', selection: { start: 4, end: 4 } });
		const handle = ref.current!;
		unmount();
		expect(() => handle.getSnapshot()).toThrow('unavailable');
	});
	it('pairs external replacements and line-ending-only updates with current selection', () => {
		const ref = createRef<MarkdownEditorHandle>();
		const onChange = vi.fn();
		const props = { onChange, language: 'text', theme: mockTheme };
		const { rerender, unmount } = render(<MarkdownEditor ref={ref} value={'a\nb'} {...props} />);
		act(() => ref.current!.setSelection(2, 3));
		rerender(<MarkdownEditor ref={ref} value={'a\r\nb'} {...props} />);
		expect(ref.current!.getSnapshot()).toEqual({ text: 'a\r\nb', selection: { start: 3, end: 4 } });
		rerender(<MarkdownEditor ref={ref} value={'x\r\ny\r\n🌍'} {...props} />);
		act(() => ref.current!.setSelection(4, 6));
		expect(ref.current!.getSnapshot()).toEqual({
			text: 'x\r\ny\r\n🌍',
			selection: { start: 6, end: 8 },
		});
		expect(onChange).not.toHaveBeenCalled();
		unmount();
	});
});
