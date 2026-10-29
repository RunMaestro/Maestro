import React, { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MarkdownEditorHandle } from '../../renderer/components/FilePreview/markdownEditor';
import { markdownEditorModuleMock } from './mockMarkdownEditor';

const { MarkdownEditor } = markdownEditorModuleMock();

describe('shared MarkdownEditor double snapshots', () => {
	it.each(['a\nb\n🌍', 'a\r\nb\r\n🌍', 'a\rb\r🌍', 'a\r\nb\n🌍'])(
		'maps normalized textarea selections to the original text: %j',
		(text) => {
			const ref = createRef<MarkdownEditorHandle>();
			const { getByRole, unmount } = render(
				<MarkdownEditor ref={ref} value={text} onChange={vi.fn()} />
			);
			const area = getByRole('textbox') as HTMLTextAreaElement;
			for (const selected of ['b', '🌍']) {
				const start = area.value.indexOf(selected);
				area.setSelectionRange(start, start + selected.length);
				const snapshot = ref.current!.getSnapshot();
				expect(snapshot.text).toBe(text);
				expect(snapshot.selection).toEqual({
					start: text.indexOf(selected),
					end: text.indexOf(selected) + selected.length,
				});
				expect(snapshot.text.slice(snapshot.selection.start, snapshot.selection.end)).toBe(
					selected
				);
			}
			unmount();
		}
	);
});
