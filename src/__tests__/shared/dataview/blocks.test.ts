/**
 * Tests for `extractDataviewBlocks` (src/shared/dataview/blocks.ts): which fences count as Dataview
 * blocks, their source and 1-based line, and the fence awareness markdown-it gives (DEV-4).
 */

import { describe, it, expect } from 'vitest';
import { extractDataviewBlocks } from '../../../shared/dataview';

describe('extractDataviewBlocks', () => {
	it('lists dataview and dataviewjs fences in order with their source and opening line', () => {
		const markdown = [
			'# Note', //                          1
			'```dataview', //                     2
			'TABLE Company, Role', //             3
			'FROM "People"', //                   4
			'```', //                             5
			'', //                                6
			'```dataviewjs', //                   7
			'dv.paragraph("hi")', //              8
			'```', //                             9
			'~~~dataview', //                     10
			'LIST', //                            11
			'~~~', //                             12
		].join('\n');

		expect(extractDataviewBlocks(markdown)).toEqual([
			{ language: 'dataview', source: 'TABLE Company, Role\nFROM "People"', line: 2 },
			{ language: 'dataviewjs', source: 'dv.paragraph("hi")', line: 7 },
			{ language: 'dataview', source: 'LIST', line: 10 },
		]);
	});

	it('ignores other languages, a language that only starts with dataview, and case variants', () => {
		const markdown = [
			'```ts',
			'const x = 1;',
			'```',
			'```dataviews',
			'LIST',
			'```',
			'```DataView',
			'LIST',
			'```',
			'```',
			'LIST',
			'```',
		].join('\n');

		expect(extractDataviewBlocks(markdown)).toEqual([]);
	});

	it('reads the language as the first word of the info string', () => {
		expect(extractDataviewBlocks('```dataview title="x"\nLIST\n```')).toEqual([
			{ language: 'dataview', source: 'LIST', line: 1 },
		]);
	});

	it('does not count a fence shown inside another fence, or an indented code block', () => {
		const markdown = [
			'````markdown', //  1
			'```dataview', //   2
			'LIST', //          3
			'```', //           4
			'````', //          5
			'', //              6
			'    ```dataview', // 7 (indented code)
			'    LIST', //      8
			'    ```', //       9
		].join('\n');

		expect(extractDataviewBlocks(markdown)).toEqual([]);
	});

	it('finds fences nested in lists and blockquotes, with their markers stripped', () => {
		const markdown = [
			'- item', //            1
			'  ```dataview', //     2
			'  LIST', //            3
			'  ```', //             4
			'', //                  5
			'> ```dataview', //     6
			'> TASK', //            7
			'> ```', //             8
		].join('\n');

		expect(extractDataviewBlocks(markdown)).toEqual([
			{ language: 'dataview', source: 'LIST', line: 2 },
			{ language: 'dataview', source: 'TASK', line: 6 },
		]);
	});

	it('skips the frontmatter and keeps lines file-relative', () => {
		const markdown = [
			'---', //                  1
			'example: |', //           2
			'  ```dataview', //        3
			'  LIST', //               4
			'  ```', //                5
			'---', //                  6
			'```dataview', //          7
			'LIST', //                 8
			'```', //                  9
		].join('\n');

		expect(extractDataviewBlocks(markdown)).toEqual([
			{ language: 'dataview', source: 'LIST', line: 7 },
		]);
	});

	it('handles CRLF line endings, an empty block, and an unclosed fence', () => {
		expect(extractDataviewBlocks('```dataview\r\nLIST\r\n```\r\n')).toEqual([
			{ language: 'dataview', source: 'LIST', line: 1 },
		]);
		expect(extractDataviewBlocks('```dataview\n```')).toEqual([
			{ language: 'dataview', source: '', line: 1 },
		]);
		// CommonMark closes an unclosed fence at the end of the document.
		expect(extractDataviewBlocks('text\n\n```dataview\nLIST')).toEqual([
			{ language: 'dataview', source: 'LIST', line: 3 },
		]);
	});
});
