/**
 * Tests for src/renderer/utils/fileReviewComments.ts: pinning a comment to
 * lines of a file, telling when its lines moved, and the exact prompt a file
 * review becomes (the same shape as a Git Diff review's).
 */
import { describe, it, expect } from 'vitest';
import {
	anchorForFileLines,
	findOutdatedFileComments,
	formatCommentOnLinesLabel,
	formatFileCommentLocation,
	formatFileReviewPrompt,
	type FileComment,
} from '../../../renderer/utils/fileReviewComments';
import { formatReviewPrompt } from '../../../renderer/utils/reviewPrompt';

const DOC = ['# Plan', '', 'Ship the parser.', 'Then the CLI.', 'Done.'].join('\n');

function comment(overrides: Partial<FileComment> = {}): FileComment {
	const anchor = anchorForFileLines({ content: DOC, path: 'docs/plan.md', startLine: 3 })!;
	return { ...anchor, id: 'c1', body: 'Say which parser.', language: 'markdown', ...overrides };
}

describe('anchorForFileLines', () => {
	it('quotes the covered lines and orders a reversed span', () => {
		expect(
			anchorForFileLines({ content: DOC, path: 'docs/plan.md', startLine: 4, endLine: 3 })
		).toEqual({
			path: 'docs/plan.md',
			startLine: 3,
			endLine: 4,
			lineContents: ['Ship the parser.', 'Then the CLI.'],
			language: undefined,
		});
	});

	it('refuses a line outside the file', () => {
		expect(anchorForFileLines({ content: DOC, path: 'p', startLine: 0 })).toBeNull();
		expect(anchorForFileLines({ content: DOC, path: 'p', startLine: 5, endLine: 6 })).toBeNull();
	});

	it('reads CRLF files without the carriage returns', () => {
		const anchor = anchorForFileLines({ content: 'a\r\nb\r\n', path: 'p', startLine: 2 });
		expect(anchor?.lineContents).toEqual(['b']);
	});
});

describe('findOutdatedFileComments', () => {
	it('keeps a comment current while its lines read the same', () => {
		expect(findOutdatedFileComments([comment()], DOC).size).toBe(0);
	});

	it('flags a comment whose line changed, or moved under an insertion above it', () => {
		const edited = DOC.replace('Ship the parser.', 'Ship the lexer.');
		const shifted = `Intro\n${DOC}`;
		expect(findOutdatedFileComments([comment()], edited)).toEqual(new Set(['c1']));
		expect(findOutdatedFileComments([comment()], shifted)).toEqual(new Set(['c1']));
	});

	it('flags a comment whose lines were cut off the end of the file', () => {
		const c = comment({ startLine: 5, endLine: 5, lineContents: ['Done.'] });
		expect(findOutdatedFileComments([c], '# Plan')).toEqual(new Set(['c1']));
	});
});

describe('labels', () => {
	it('names one line or a span', () => {
		expect(formatCommentOnLinesLabel(12)).toBe('Comment on Line 12');
		expect(formatCommentOnLinesLabel(12, 14)).toBe('Comment on Lines 12-14');
		expect(formatFileCommentLocation(comment())).toBe('docs/plan.md:3');
	});
});

describe('formatFileReviewPrompt', () => {
	it('writes every comment top to bottom with its path:lines and quoted lines', () => {
		const later = comment({
			id: 'c2',
			startLine: 4,
			endLine: 5,
			lineContents: ['Then the CLI.', 'Done.'],
			body: 'Merge these.',
		});
		expect(formatFileReviewPrompt([later, comment()])).toBe(
			[
				'I reviewed `docs/plan.md` and left 2 comments pinned to specific lines. Please address each one.',
				'',
				'Each comment names the file and lines it is about, then quotes those lines as they read when I commented.',
				'',
				'## Comment 1 of 2',
				'',
				'`docs/plan.md:3`',
				'```markdown',
				'Ship the parser.',
				'```',
				'',
				'Say which parser.',
				'',
				'## Comment 2 of 2',
				'',
				'`docs/plan.md:4-5`',
				'```markdown',
				'Then the CLI.',
				'Done.',
				'```',
				'',
				'Merge these.',
			].join('\n')
		);
	});

	it('skips comments with no text and returns empty when nothing is left', () => {
		expect(formatFileReviewPrompt([comment({ body: '  ' })])).toBe('');
		expect(formatFileReviewPrompt([])).toBe('');
	});
});

describe('formatReviewPrompt', () => {
	it('puts notes between the quote and the comment', () => {
		const prompt = formatReviewPrompt(
			['Intro.'],
			[
				{
					selection: { path: 'a.ts', startLine: 1, endLine: 1, text: 'x', language: 'ts' },
					notes: ['A note.'],
					body: ' Fix. ',
				},
			]
		);
		expect(prompt).toBe(
			[
				'Intro.',
				'',
				'## Comment 1 of 1',
				'',
				'`a.ts:1`',
				'```ts',
				'x',
				'```',
				'',
				'A note.',
				'',
				'Fix.',
			].join('\n')
		);
	});
});
