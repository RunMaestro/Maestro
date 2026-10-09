/**
 * Tests for the diff annotation model and the prompt it serializes into.
 *
 * The prompt is what the agent reads, so its shape is pinned: every comment
 * must name its file and line, say which file version a removed line's number
 * belongs to, and quote the code so the agent can find it without guessing.
 */
import { describe, it, expect } from 'vitest';
import type { ChangeData } from 'react-diff-view';
import {
	anchorForChange,
	formatAnnotationLocation,
	formatDiffReviewPrompt,
	type DiffAnnotation,
} from '../../../renderer/utils/diffAnnotations';

const insert = {
	type: 'insert',
	isInsert: true,
	content: 'const b = 2;',
	lineNumber: 7,
} as ChangeData;
const remove = {
	type: 'delete',
	isDelete: true,
	content: 'const a = 1;',
	lineNumber: 4,
} as ChangeData;
const normal = {
	type: 'normal',
	isNormal: true,
	content: 'return x;',
	oldLineNumber: 10,
	newLineNumber: 12,
} as ChangeData;

function annotation(overrides: Partial<DiffAnnotation>): DiffAnnotation {
	return {
		id: 'a',
		file: 'src/app.ts',
		line: 1,
		side: 'new',
		kind: 'added',
		lineText: 'code',
		changeKey: 'I1',
		body: 'comment',
		...overrides,
	};
}

describe('anchorForChange', () => {
	it('anchors an added line to the new file', () => {
		expect(anchorForChange('src/app.ts', insert)).toEqual({
			file: 'src/app.ts',
			line: 7,
			side: 'new',
			kind: 'added',
			lineText: 'const b = 2;',
			changeKey: 'I7',
		});
	});

	it('anchors a removed line to the old file', () => {
		expect(anchorForChange('src/app.ts', remove)).toMatchObject({
			line: 4,
			side: 'old',
			kind: 'removed',
			changeKey: 'D4',
		});
	});

	it('anchors an unchanged line to the new file by default', () => {
		expect(anchorForChange('src/app.ts', normal)).toMatchObject({
			line: 12,
			side: 'new',
			kind: 'unchanged',
		});
	});

	it('anchors an unchanged line to the old file when clicked on the old side', () => {
		expect(anchorForChange('src/app.ts', normal, 'old')).toMatchObject({ line: 10, side: 'old' });
	});

	it('keeps a leading dash or space that is part of the code', () => {
		const change = { ...insert, content: '- item' } as ChangeData;
		expect(anchorForChange('README.md', change).lineText).toBe('- item');
	});
});

describe('formatAnnotationLocation', () => {
	it('marks old-file line numbers', () => {
		expect(formatAnnotationLocation(annotation({ line: 3, side: 'new' }))).toBe('src/app.ts:3');
		expect(formatAnnotationLocation(annotation({ line: 3, side: 'old' }))).toBe(
			'src/app.ts:3 (previous version)'
		);
	});
});

describe('formatDiffReviewPrompt', () => {
	it('returns an empty string when there is nothing to send', () => {
		expect(formatDiffReviewPrompt([])).toBe('');
		expect(formatDiffReviewPrompt([annotation({ body: '   ' })])).toBe('');
	});

	it('names file and line, quotes the code, and includes the comment', () => {
		const prompt = formatDiffReviewPrompt([
			annotation({ line: 7, lineText: 'const b = 2;', body: 'Use a constant here.' }),
		]);
		expect(prompt).toContain('left 1 comment on specific lines');
		expect(prompt).toContain('## 1. src/app.ts:7');
		expect(prompt).toContain('On the added line:');
		expect(prompt).toContain('> const b = 2;');
		expect(prompt).toContain('Use a constant here.');
	});

	it('orders comments by file, then line, and skips empty ones', () => {
		const prompt = formatDiffReviewPrompt([
			annotation({ id: '1', file: 'src/z.ts', line: 1, body: 'z1' }),
			annotation({ id: '2', file: 'src/a.ts', line: 20, body: 'a20' }),
			annotation({ id: '3', file: 'src/a.ts', line: 3, body: 'a3' }),
			annotation({ id: '4', file: 'src/a.ts', line: 5, body: '' }),
		]);
		expect(prompt).toContain('left 3 comments');
		const order = ['## 1. src/a.ts:3', '## 2. src/a.ts:20', '## 3. src/z.ts:1'].map((h) =>
			prompt.indexOf(h)
		);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(prompt).not.toContain('src/a.ts:5');
	});

	it('says when a line number belongs to the previous version', () => {
		const prompt = formatDiffReviewPrompt([
			annotation({ side: 'old', kind: 'removed', line: 4, body: 'Why was this removed?' }),
		]);
		expect(prompt).toContain('## 1. src/app.ts:4 (previous version)');
		expect(prompt).toContain('On the removed line:');
	});

	it('quotes a blank line explicitly rather than emitting an empty quote', () => {
		const prompt = formatDiffReviewPrompt([annotation({ lineText: '', body: 'Drop this.' })]);
		expect(prompt).toContain('> (blank line)');
	});
});
