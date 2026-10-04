import { describe, it, expect } from 'vitest';
import { parseDiff } from 'react-diff-view';
import {
	anchorForSelection,
	buildReviewRows,
	clampToAnchorHunk,
	formatCommentLocation,
	formatDiffReviewPrompt,
	formatHunkContext,
	HUNK_CONTEXT_FULL_LIMIT,
	type DiffComment,
} from '../../../renderer/utils/diffReviewComments';

const DIFF = [
	'diff --git a/src/app.ts b/src/app.ts',
	'index 1111111..2222222 100644',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,4 +1,5 @@',
	' const keep = 1;',
	'-const old = 2;',
	'+const fresh = 3;',
	'+const extra = 4;',
	' const tail = 5;',
	' const end = 6;',
	'@@ -20,2 +21,2 @@ function later() {',
	' const a = 20;',
	'-const b = 21;',
	'+const b = 22;',
	'',
].join('\n');

const hunks = parseDiff(DIFF)[0].hunks;
const rows = buildReviewRows(hunks);
const indexOf = (content: string) => rows.findIndex((r) => r.change.content === content);

function comment(overrides: Partial<DiffComment>): DiffComment {
	return {
		id: 'c1',
		file: 'src/app.ts',
		side: 'new',
		startLine: 2,
		endLine: 2,
		changeKeys: ['I2'],
		context: '@@ -1 +1 @@\n+x',
		body: 'Fix this.',
		...overrides,
	};
}

describe('buildReviewRows', () => {
	it('flattens every change of every hunk in display order, keyed like react-diff-view', () => {
		expect(rows.map((r) => r.change.content)).toEqual([
			'const keep = 1;',
			'const old = 2;',
			'const fresh = 3;',
			'const extra = 4;',
			'const tail = 5;',
			'const end = 6;',
			'const a = 20;',
			'const b = 21;',
			'const b = 22;',
		]);
		expect(rows[2]).toMatchObject({ hunkIndex: 0, indexInHunk: 2, key: 'I2' });
		expect(rows[7]).toMatchObject({ hunkIndex: 1, indexInHunk: 1, key: 'D21' });
	});
});

describe('clampToAnchorHunk', () => {
	it('stops a range at the edge of the hunk it started in', () => {
		expect(clampToAnchorHunk(rows, 4, 7)).toBe(5);
		expect(clampToAnchorHunk(rows, 7, 2)).toBe(6);
	});

	it('leaves a focus inside the same hunk alone and clamps to the row list', () => {
		expect(clampToAnchorHunk(rows, 1, 3)).toBe(3);
		expect(clampToAnchorHunk(rows, 8, 99)).toBe(8);
	});
});

describe('anchorForSelection', () => {
	it('numbers a range in the new file when it holds any added or unchanged line', () => {
		const anchor = anchorForSelection(
			'src/app.ts',
			hunks,
			rows,
			indexOf('const old = 2;'),
			indexOf('const extra = 4;')
		);
		expect(anchor).toMatchObject({
			file: 'src/app.ts',
			side: 'new',
			startLine: 2,
			endLine: 3,
			changeKeys: ['D2', 'I2', 'I3'],
		});
	});

	it('numbers a selection of removed lines only in the old file', () => {
		const at = indexOf('const old = 2;');
		expect(anchorForSelection('src/app.ts', hunks, rows, at, at)).toMatchObject({
			side: 'old',
			startLine: 2,
			endLine: 2,
		});
	});

	it('uses the old numbering for an unchanged line picked in the split view left column', () => {
		const at = indexOf('const a = 20;');
		expect(anchorForSelection('src/app.ts', hunks, rows, at, at, 'old')).toMatchObject({
			side: 'old',
			startLine: 20,
		});
		expect(anchorForSelection('src/app.ts', hunks, rows, at, at, 'new')).toMatchObject({
			side: 'new',
			startLine: 21,
		});
	});

	it('accepts the anchor and focus in either order', () => {
		const a = anchorForSelection('f', hunks, rows, 4, 2);
		const b = anchorForSelection('f', hunks, rows, 2, 4);
		expect(a).toEqual(b);
	});

	it('refuses a range across two hunks', () => {
		expect(anchorForSelection('f', hunks, rows, 4, 7)).toBeNull();
	});

	it('captures the whole hunk, with markers, as context', () => {
		const anchor = anchorForSelection('f', hunks, rows, 2, 2);
		expect(anchor?.context).toBe(
			[
				'@@ -1,4 +1,5 @@',
				' const keep = 1;',
				'-const old = 2;',
				'+const fresh = 3;',
				'+const extra = 4;',
				' const tail = 5;',
				' const end = 6;',
			].join('\n')
		);
	});
});

describe('formatHunkContext', () => {
	it('trims a long hunk to the selection plus padding, marking the cuts', () => {
		const lines = Array.from({ length: HUNK_CONTEXT_FULL_LIMIT + 20 }, (_, i) => `+line ${i + 1}`);
		const big = parseDiff(
			['--- a/big.ts', '+++ b/big.ts', `@@ -0,0 +1,${lines.length} @@`, ...lines, ''].join('\n')
		)[0].hunks[0];
		const text = formatHunkContext(big, 30, 31).split('\n');
		expect(text[0]).toBe(`@@ -0,0 +1,${lines.length} @@`);
		expect(text[1]).toBe('...');
		expect(text[2]).toBe('+line 26');
		expect(text[text.length - 2]).toBe('+line 37');
		expect(text[text.length - 1]).toBe('...');
	});
});

describe('formatCommentLocation', () => {
	it('names path:line, path:start-end, and flags the previous version', () => {
		expect(formatCommentLocation(comment({}))).toBe('src/app.ts:2');
		expect(formatCommentLocation(comment({ startLine: 2, endLine: 5 }))).toBe('src/app.ts:2-5');
		expect(formatCommentLocation(comment({ side: 'old' }))).toBe('src/app.ts:2 (previous version)');
	});
});

describe('formatDiffReviewPrompt', () => {
	it('returns an empty string when no comment has a body', () => {
		expect(formatDiffReviewPrompt([])).toBe('');
		expect(formatDiffReviewPrompt([comment({ body: '   ' })])).toBe('');
	});

	it('pins each comment to path:lines with its hunk in a diff fence, sorted by file then line', () => {
		const prompt = formatDiffReviewPrompt([
			comment({ id: 'b', file: 'src/z.ts', startLine: 9, endLine: 9, body: 'Second file.' }),
			comment({ id: 'a', startLine: 4, endLine: 6, body: 'Later line.' }),
			comment({ id: 'c', side: 'old', startLine: 2, endLine: 2, body: '  Why remove this?  ' }),
		]);
		expect(prompt).toBe(
			[
				'I reviewed your changes in the git diff and left 3 comments pinned to specific lines. Please address each one.',
				'',
				'Each comment names the file and lines it is about, then quotes the diff hunk it was left on. Line numbers refer to the current version of the file, except where a comment says they refer to the previous version (the lines were removed).',
				'',
				'## Comment 1 of 3',
				'',
				'`src/app.ts:2`',
				'```diff',
				'@@ -1 +1 @@',
				'+x',
				'```',
				'',
				'These line numbers refer to the previous version of the file.',
				'',
				'Why remove this?',
				'',
				'## Comment 2 of 3',
				'',
				'`src/app.ts:4-6`',
				'```diff',
				'@@ -1 +1 @@',
				'+x',
				'```',
				'',
				'Later line.',
				'',
				'## Comment 3 of 3',
				'',
				'`src/z.ts:9`',
				'```diff',
				'@@ -1 +1 @@',
				'+x',
				'```',
				'',
				'Second file.',
			].join('\n')
		);
	});

	it('lengthens the fence when the hunk itself contains a code fence', () => {
		const prompt = formatDiffReviewPrompt([comment({ context: '@@ -1 +1 @@\n+```js' })]);
		expect(prompt).toContain('````diff\n@@ -1 +1 @@\n+```js\n````');
		expect(prompt).toContain('left 1 comment pinned');
	});
});
