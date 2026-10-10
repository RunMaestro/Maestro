/**
 * `minimalReplacement` is how the MarkdownEditor applies a new `value` from its
 * host. Replacing only the span that differs is what keeps the caret where the
 * user left it when a disk change (an agent ticking a box) lands elsewhere.
 */

import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { minimalReplacement } from '../../../../renderer/components/FilePreview/markdownEditor/MarkdownEditor';

const apply = (current: string, next: string) =>
	EditorState.create({ doc: current }).update({ changes: minimalReplacement(current, next) }).state;

describe('minimalReplacement', () => {
	it.each([
		['middle edit', '- [ ] one\n- [ ] two', '- [ ] one\n- [x] two'],
		['append', 'abc', 'abcdef'],
		['prepend', 'def', 'abcdef'],
		['delete all', 'abc', ''],
		['from empty', '', 'abc'],
		['repeated chars', 'aaaa', 'aa'],
		['emoji', 'a 🌍 b', 'a 🎉 b'],
	])('reproduces the target document (%s)', (_label, current, next) => {
		expect(apply(current, next).doc.toString()).toBe(next);
	});

	it('touches only the differing span', () => {
		expect(minimalReplacement('- [ ] one\n- [ ] two', '- [ ] one\n- [x] two')).toEqual({
			from: 13,
			to: 14,
			insert: 'x',
		});
	});

	it('leaves a caret outside the change where it was', () => {
		const current = 'Line one.\n- [ ] task';
		const state = EditorState.create({ doc: current, selection: { anchor: 4 } });
		const next = state.update({
			changes: minimalReplacement(current, 'Line one.\n- [x] task'),
		}).state;
		expect(next.selection.main.head).toBe(4);
	});
});
