/**
 * Shared `MarkdownEditor` test double.
 *
 * The real editor wraps CodeMirror 6, which measures DOM text to lay itself
 * out - jsdom returns zeros and CM6 throws (`textRange(...).getClientRects is
 * not a function`). Every suite that renders a surface containing the editor
 * therefore mocks the module.
 *
 * This double is a plain `<textarea>` that also implements
 * `MarkdownEditorHandle` against that textarea, so host code driving the
 * editor imperatively (caret reads, range replacement, selection, scroll
 * sync) exercises real logic instead of no-op stubs, and `getByRole('textbox')`
 * / `fireEvent.change` keep working.
 *
 * Usage - the path must be spelled relative to the TEST file, because
 * `vi.mock` resolves its first argument from the file that calls it:
 *
 * ```ts
 * vi.mock('../../../renderer/components/FilePreview/markdownEditor', async () => {
 *   const { markdownEditorModuleMock } = await import('../../helpers/mockMarkdownEditor');
 *   return markdownEditorModuleMock();
 * });
 * ```
 */

import React from 'react';

interface MockEditorProps {
	value: string;
	onChange?: (value: string) => void;
	onKeyDown?: (event: KeyboardEvent) => boolean | void;
	onPaste?: (event: ClipboardEvent) => boolean | void;
	placeholder?: string;
	readOnly?: boolean;
	showLineNumbers?: boolean;
	className?: string;
	/**
	 * Surface typography. The real editor hands these to CodeMirror's theme
	 * compartment; the double puts them on the textarea's inline style so a
	 * suite can still assert that a surface's font setting reaches the editor.
	 */
	fontFamily?: string;
	baseFontPx?: number;
}

/**
 * The mocked module body. Spread it into a `vi.mock` factory so the suite can
 * add its own exports alongside.
 */
export function markdownEditorModuleMock() {
	const MarkdownEditor = React.forwardRef<unknown, MockEditorProps>(function MockMarkdownEditor(
		{
			value,
			onChange,
			onKeyDown,
			onPaste,
			placeholder,
			readOnly,
			className,
			fontFamily,
			baseFontPx,
		},
		ref
	) {
		const textareaRef = React.useRef<HTMLTextAreaElement>(null);

		React.useImperativeHandle(ref, () => ({
			focus() {
				textareaRef.current?.focus();
			},
			scrollToLine(line: number, opts?: { select?: boolean }) {
				const el = textareaRef.current;
				if (!el) return;
				const offset = el.value
					.split('\n')
					.slice(0, Math.max(0, line - 1))
					.reduce((sum, text) => sum + text.length + 1, 0);
				if (opts?.select !== false) el.setSelectionRange(offset, offset);
			},
			getTopLine() {
				return 1;
			},
			getScrollPercent() {
				const el = textareaRef.current;
				if (!el) return 0;
				const max = el.scrollHeight - el.clientHeight;
				return max > 0 ? el.scrollTop / max : 0;
			},
			setScrollPercent(percent: number) {
				const el = textareaRef.current;
				if (!el) return;
				const max = el.scrollHeight - el.clientHeight;
				el.scrollTop = Math.round(Math.max(0, Math.min(1, percent)) * max);
			},
			getScrollTop() {
				return textareaRef.current?.scrollTop ?? 0;
			},
			setScrollTop(px: number) {
				if (textareaRef.current) textareaRef.current.scrollTop = Math.max(0, px);
			},
			setSelection(from: number, to: number) {
				textareaRef.current?.setSelectionRange(from, to);
			},
			getCaret() {
				return textareaRef.current?.selectionStart ?? 0;
			},
			getSelectionRange() {
				const el = textareaRef.current;
				return { from: el?.selectionStart ?? 0, to: el?.selectionEnd ?? 0 };
			},
			coordsAtPos() {
				return { top: 0, left: 0 };
			},
			replaceRange(from: number, to: number, text: string) {
				const el = textareaRef.current;
				const current = el?.value ?? value;
				const next = current.slice(0, from) + text + current.slice(to);
				// The real editor's dispatch fires onChange, so the host's state is
				// updated through the same path a keystroke takes.
				onChange?.(next);
				el?.setSelectionRange(from + text.length, from + text.length);
			},
			setSearchMatches() {
				// Painted decorations have no jsdom equivalent.
			},
			getContentEl() {
				return textareaRef.current;
			},
		}));

		return (
			<textarea
				ref={textareaRef}
				value={value}
				placeholder={placeholder}
				readOnly={readOnly}
				className={className}
				style={{
					...(fontFamily ? { fontFamily } : {}),
					...(baseFontPx ? { fontSize: `${baseFontPx}px` } : {}),
				}}
				onChange={(e) => onChange?.(e.target.value)}
				onKeyDown={(e) => onKeyDown?.(e.nativeEvent)}
				onPaste={(e) => onPaste?.(e.nativeEvent as ClipboardEvent)}
			/>
		);
	});

	return { MarkdownEditor, default: MarkdownEditor };
}
