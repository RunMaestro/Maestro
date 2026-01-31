import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dompurify', () => ({
	default: { sanitize: vi.fn((html: string) => html) },
}));

import {
	processCarriageReturns,
	processLogTextHelper,
	filterTextByLinesHelper,
	stripMarkdown,
	ANSI_CACHE_MAX_SIZE,
	getCachedAnsiHtml,
	clearAnsiCache,
} from '../../../renderer/utils/textProcessing';

// ============================================================================
// processCarriageReturns
// ============================================================================

describe('processCarriageReturns', () => {
	it('returns text unchanged when there are no carriage returns', () => {
		expect(processCarriageReturns('hello world')).toBe('hello world');
	});

	it('handles empty string', () => {
		expect(processCarriageReturns('')).toBe('');
	});

	it('replaces line content with text after a single \\r', () => {
		expect(processCarriageReturns('old text\rnew text')).toBe('new text');
	});

	it('takes the last non-empty segment when multiple \\r are present on the same line', () => {
		expect(processCarriageReturns('first\rsecond\rthird')).toBe('third');
	});

	it('skips empty trailing segments to find the last non-empty one', () => {
		// "first\rsecond\r" -> segments: ["first", "second", ""]
		// last non-empty is "second"
		expect(processCarriageReturns('first\rsecond\r')).toBe('second');
	});

	it('returns empty string when all segments after \\r are empty or whitespace-only', () => {
		// "\r\r" -> segments: ["", "", ""]
		// all are empty/whitespace -> returns ""
		expect(processCarriageReturns('\r\r')).toBe('');
	});

	it('returns empty string for a single \\r', () => {
		expect(processCarriageReturns('\r')).toBe('');
	});

	it('handles mixed lines with and without carriage returns', () => {
		const input = 'line one\nold\rnew\nline three';
		expect(processCarriageReturns(input)).toBe('line one\nnew\nline three');
	});

	it('preserves newlines between processed lines', () => {
		const input = 'a\nb\nc';
		expect(processCarriageReturns(input)).toBe('a\nb\nc');
	});

	it('handles carriage returns on multiple lines independently', () => {
		const input = 'x\ry\nfoo\rbar\rbaz';
		// Line 1: "x\ry" -> last non-empty is "y"
		// Line 2: "foo\rbar\rbaz" -> last non-empty is "baz"
		expect(processCarriageReturns(input)).toBe('y\nbaz');
	});

	it('simulates progress indicator overwrites', () => {
		const input = 'Progress: 10%\rProgress: 50%\rProgress: 100%';
		expect(processCarriageReturns(input)).toBe('Progress: 100%');
	});
});

// ============================================================================
// processLogTextHelper
// ============================================================================

describe('processLogTextHelper', () => {
	describe('non-terminal mode', () => {
		it('returns carriage-return-processed text without filtering', () => {
			const input = 'old\rnew\n\n$\nbash-5.2$';
			const result = processLogTextHelper(input, false);
			// Should apply CR processing but NOT filter prompts or empty lines
			expect(result).toBe('new\n\n$\nbash-5.2$');
		});

		it('returns empty lines intact in non-terminal mode', () => {
			const input = 'line1\n\n\nline2';
			expect(processLogTextHelper(input, false)).toBe('line1\n\n\nline2');
		});
	});

	describe('terminal mode', () => {
		it('filters out empty lines', () => {
			const input = 'line1\n\n\nline2';
			expect(processLogTextHelper(input, true)).toBe('line1\nline2');
		});

		it('filters out bash prompt "bash-5.2$"', () => {
			const input = 'output\nbash-5.2$\nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('filters out bash prompt with trailing space "bash-5.2$ "', () => {
			const input = 'output\nbash-5.2$ \nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('filters out zsh% prompt', () => {
			const input = 'output\nzsh%\nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('filters out zsh# prompt', () => {
			const input = 'output\nzsh#\nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('filters out standalone $ prompt', () => {
			const input = 'output\n$\nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('filters out standalone # prompt', () => {
			const input = 'output\n#\nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('filters out prompts with leading whitespace', () => {
			const input = 'output\n  $  \nmore output';
			expect(processLogTextHelper(input, true)).toBe('output\nmore output');
		});

		it('keeps lines that contain prompts as part of other text', () => {
			const input = 'echo $ hello\nprice is $5\nbash-5.2$ echo hello';
			// These lines have content beyond just the prompt pattern
			expect(processLogTextHelper(input, true)).toBe(
				'echo $ hello\nprice is $5\nbash-5.2$ echo hello'
			);
		});

		it('filters combination of prompts and empty lines, keeps real output', () => {
			const input = 'bash-5.2$\n\nreal output\n$\n\nzsh%\nanother line\n#';
			expect(processLogTextHelper(input, true)).toBe('real output\nanother line');
		});

		it('applies carriage return processing before filtering', () => {
			const input = 'old\rnew\nbash-5.2$\n\nkeep this';
			expect(processLogTextHelper(input, true)).toBe('new\nkeep this');
		});

		it('returns empty string when all lines are prompts or empty', () => {
			const input = 'bash-5.2$\n\n$\n#\nzsh%';
			expect(processLogTextHelper(input, true)).toBe('');
		});

		it('filters bash prompts with different version numbers', () => {
			const input = 'bash-4.4$\nbash-5.2$\nbash-3.0$';
			expect(processLogTextHelper(input, true)).toBe('');
		});
	});
});

// ============================================================================
// filterTextByLinesHelper
// ============================================================================

describe('filterTextByLinesHelper', () => {
	const sampleText = 'Error: file not found\nWarning: low memory\nInfo: process started\nError: timeout';

	describe('empty query', () => {
		it('returns original text when query is empty string', () => {
			expect(filterTextByLinesHelper(sampleText, '', 'include', false)).toBe(sampleText);
		});

		it('returns original text when query is empty in exclude mode', () => {
			expect(filterTextByLinesHelper(sampleText, '', 'exclude', false)).toBe(sampleText);
		});

		it('returns original text when query is empty with regex enabled', () => {
			expect(filterTextByLinesHelper(sampleText, '', 'include', true)).toBe(sampleText);
		});
	});

	describe('include mode - plain text', () => {
		it('keeps lines containing the query (case-insensitive)', () => {
			const result = filterTextByLinesHelper(sampleText, 'error', 'include', false);
			expect(result).toBe('Error: file not found\nError: timeout');
		});

		it('is case-insensitive', () => {
			const result = filterTextByLinesHelper(sampleText, 'ERROR', 'include', false);
			expect(result).toBe('Error: file not found\nError: timeout');
		});

		it('matches partial words', () => {
			const result = filterTextByLinesHelper(sampleText, 'warn', 'include', false);
			expect(result).toBe('Warning: low memory');
		});

		it('returns empty when no lines match', () => {
			const result = filterTextByLinesHelper(sampleText, 'xyz', 'include', false);
			expect(result).toBe('');
		});
	});

	describe('exclude mode - plain text', () => {
		it('removes lines containing the query', () => {
			const result = filterTextByLinesHelper(sampleText, 'error', 'exclude', false);
			expect(result).toBe('Warning: low memory\nInfo: process started');
		});

		it('is case-insensitive in exclude mode', () => {
			const result = filterTextByLinesHelper(sampleText, 'WARNING', 'exclude', false);
			expect(result).toBe('Error: file not found\nInfo: process started\nError: timeout');
		});

		it('returns all lines when no lines match the exclude query', () => {
			const result = filterTextByLinesHelper(sampleText, 'xyz', 'exclude', false);
			expect(result).toBe(sampleText);
		});
	});

	describe('include mode - regex', () => {
		it('filters using a valid regex pattern', () => {
			const result = filterTextByLinesHelper(sampleText, '^Error', 'include', true);
			expect(result).toBe('Error: file not found\nError: timeout');
		});

		it('supports regex special characters', () => {
			const result = filterTextByLinesHelper(sampleText, 'Error.*timeout', 'include', true);
			expect(result).toBe('Error: timeout');
		});

		it('is case-insensitive in regex mode', () => {
			const result = filterTextByLinesHelper(sampleText, 'error', 'include', true);
			expect(result).toBe('Error: file not found\nError: timeout');
		});
	});

	describe('exclude mode - regex', () => {
		it('excludes lines matching regex pattern', () => {
			const result = filterTextByLinesHelper(sampleText, '^(Error|Warning)', 'exclude', true);
			expect(result).toBe('Info: process started');
		});
	});

	describe('invalid regex fallback', () => {
		it('falls back to plain text search when regex is invalid', () => {
			// "[" is an invalid regex (unclosed bracket)
			const text = 'line with [bracket\nline without\nanother [bracket] line';
			const result = filterTextByLinesHelper(text, '[bracket', 'include', true);
			// Falls back to plain text includes() which matches "[bracket"
			expect(result).toBe('line with [bracket\nanother [bracket] line');
		});

		it('falls back to plain text search in exclude mode with invalid regex', () => {
			const text = 'line with [bracket\nline without';
			const result = filterTextByLinesHelper(text, '[bracket', 'exclude', true);
			expect(result).toBe('line without');
		});
	});

	describe('multi-line filtering', () => {
		it('handles single line text', () => {
			expect(filterTextByLinesHelper('hello world', 'hello', 'include', false)).toBe(
				'hello world'
			);
		});

		it('handles text with many lines', () => {
			const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
			const text = lines.join('\n');
			const result = filterTextByLinesHelper(text, 'line 5', 'include', false);
			// Should match "line 5", "line 50"-"line 59"
			const resultLines = result.split('\n');
			expect(resultLines).toContain('line 5');
			expect(resultLines).toContain('line 50');
			expect(resultLines.length).toBe(11); // line 5, line 50-59
		});
	});
});

// ============================================================================
// stripMarkdown
// ============================================================================

describe('stripMarkdown', () => {
	it('strips code blocks keeping content', () => {
		const input = '```javascript\nconst x = 1;\nconsole.log(x);\n```';
		expect(stripMarkdown(input)).toBe('const x = 1;\nconsole.log(x);');
	});

	it('strips code blocks with no language specifier', () => {
		const input = '```\ncode here\n```';
		expect(stripMarkdown(input)).toBe('code here');
	});

	it('strips inline code backticks', () => {
		expect(stripMarkdown('use `npm install` to install')).toBe('use npm install to install');
	});

	it('strips bold with double asterisks', () => {
		expect(stripMarkdown('this is **bold** text')).toBe('this is bold text');
	});

	it('strips bold with double underscores', () => {
		expect(stripMarkdown('this is __bold__ text')).toBe('this is bold text');
	});

	it('strips italic with single asterisks', () => {
		expect(stripMarkdown('this is *italic* text')).toBe('this is italic text');
	});

	it('strips italic with single underscores', () => {
		expect(stripMarkdown('this is _italic_ text')).toBe('this is italic text');
	});

	it('strips bold italic with triple asterisks', () => {
		expect(stripMarkdown('this is ***bold italic*** text')).toBe('this is bold italic text');
	});

	it('strips bold italic with triple underscores', () => {
		expect(stripMarkdown('this is ___bold italic___ text')).toBe('this is bold italic text');
	});

	it('strips headers of various levels', () => {
		expect(stripMarkdown('# Header 1')).toBe('Header 1');
		expect(stripMarkdown('## Header 2')).toBe('Header 2');
		expect(stripMarkdown('### Header 3')).toBe('Header 3');
		expect(stripMarkdown('###### Header 6')).toBe('Header 6');
	});

	it('strips blockquotes', () => {
		expect(stripMarkdown('> This is a quote')).toBe('This is a quote');
	});

	it('strips multi-line blockquotes', () => {
		const input = '> line one\n> line two';
		expect(stripMarkdown(input)).toBe('line one\nline two');
	});

	it('preserves horizontal rules as --- for dash-based rules', () => {
		expect(stripMarkdown('---')).toBe('---');
		expect(stripMarkdown('----')).toBe('---');
		expect(stripMarkdown('----------')).toBe('---');
	});

	it('transforms asterisk/underscore horizontal rules through bold/italic stripping first', () => {
		// *** gets processed by *(.+?)* first (matches middle *), leaving *
		// ___ gets processed by _(.+?)_ first (matches middle _), leaving _
		// This is expected behavior: the bold/italic regexes run before the HR regex
		expect(stripMarkdown('***')).toBe('*');
		expect(stripMarkdown('___')).toBe('_');
	});

	it('converts links to just the text', () => {
		expect(stripMarkdown('[Click here](https://example.com)')).toBe('Click here');
	});

	it('processes images: link regex runs first, leaving the ! prefix', () => {
		// The link regex [text](url) matches inside ![alt](url) first,
		// so ![Alt text](image.png) -> !Alt text (the image regex cannot match afterward)
		expect(stripMarkdown('![Alt text](image.png)')).toBe('!Alt text');
	});

	it('strips strikethrough', () => {
		expect(stripMarkdown('this is ~~deleted~~ text')).toBe('this is deleted text');
	});

	it('normalizes bullet points to dash prefix', () => {
		expect(stripMarkdown('* item one')).toBe('- item one');
		expect(stripMarkdown('+ item two')).toBe('- item two');
		expect(stripMarkdown('- item three')).toBe('- item three');
	});

	it('normalizes indented bullet points', () => {
		expect(stripMarkdown('  * nested item')).toBe('- nested item');
		expect(stripMarkdown('    + deep nested')).toBe('- deep nested');
	});

	it('normalizes numbered lists', () => {
		expect(stripMarkdown('1. First item')).toBe('1. First item');
		expect(stripMarkdown('  2. Second item')).toBe('2. Second item');
	});

	it('handles a complex markdown document', () => {
		const input = [
			'# Title',
			'',
			'This is **bold** and *italic* text.',
			'',
			'> A blockquote',
			'',
			'```python',
			'print("hello")',
			'```',
			'',
			'- Item 1',
			'- Item 2',
			'',
			'[Link](https://example.com) and ![Image](pic.png)',
			'',
			'~~removed~~',
		].join('\n');

		const expected = [
			'Title',
			'',
			'This is bold and italic text.',
			'',
			'A blockquote',
			'',
			// Note: blank line between code block output and bullet list is consumed
			// by the bullet point regex (^[\s]*[-*+]\s+ greedily matches preceding \n)
			'print("hello")',
			'- Item 1',
			'- Item 2',
			'',
			// Note: ![Image](pic.png) becomes !Image because link regex runs before image regex
			'Link and !Image',
			'',
			'removed',
		].join('\n');

		expect(stripMarkdown(input)).toBe(expected);
	});

	it('returns plain text unchanged', () => {
		expect(stripMarkdown('just plain text')).toBe('just plain text');
	});

	it('handles empty string', () => {
		expect(stripMarkdown('')).toBe('');
	});
});

// ============================================================================
// ANSI Cache
// ============================================================================

describe('ANSI_CACHE_MAX_SIZE', () => {
	it('equals 500', () => {
		expect(ANSI_CACHE_MAX_SIZE).toBe(500);
	});
});

describe('getCachedAnsiHtml', () => {
	let mockConverter: { toHtml: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		clearAnsiCache();
		mockConverter = {
			toHtml: vi.fn((text: string) => `<span>${text}</span>`),
		};
	});

	it('converts text and returns the result', () => {
		const result = getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		expect(result).toBe('<span>hello</span>');
		expect(mockConverter.toHtml).toHaveBeenCalledWith('hello');
	});

	it('returns cached result on second call with same text and theme', () => {
		getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		const result = getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		expect(result).toBe('<span>hello</span>');
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(1);
	});

	it('creates separate cache entries for different themes', () => {
		getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		getCachedAnsiHtml('hello', 'light', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(2);
	});

	it('creates separate cache entries for different texts', () => {
		getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		getCachedAnsiHtml('world', 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(2);
	});

	it('uses substring-based key for long texts (>200 chars)', () => {
		const longText = 'A'.repeat(250);
		const result = getCachedAnsiHtml(longText, 'dark', mockConverter as never);
		expect(result).toBe(`<span>${longText}</span>`);

		// Second call should use cached result
		const result2 = getCachedAnsiHtml(longText, 'dark', mockConverter as never);
		expect(result2).toBe(`<span>${longText}</span>`);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(1);
	});

	it('differentiates long texts with different content but same length', () => {
		// Two texts of same length but different first/last 100 chars
		const text1 = 'A'.repeat(100) + 'X'.repeat(100) + 'B'.repeat(100);
		const text2 = 'C'.repeat(100) + 'X'.repeat(100) + 'D'.repeat(100);
		getCachedAnsiHtml(text1, 'dark', mockConverter as never);
		getCachedAnsiHtml(text2, 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(2);
	});

	it('evicts oldest entry when cache exceeds max size', () => {
		// Fill cache to max size
		for (let i = 0; i < ANSI_CACHE_MAX_SIZE; i++) {
			getCachedAnsiHtml(`text-${i}`, 'dark', mockConverter as never);
		}
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(ANSI_CACHE_MAX_SIZE);

		// Add one more, which should evict the first entry ("text-0")
		getCachedAnsiHtml('new-text', 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(ANSI_CACHE_MAX_SIZE + 1);

		// "text-0" was evicted, so requesting it triggers a new conversion
		getCachedAnsiHtml('text-0', 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(ANSI_CACHE_MAX_SIZE + 2);

		// An entry near the end of the cache should still be cached
		// "text-499" was the most recently added (before "new-text"), still present
		getCachedAnsiHtml('text-499', 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(ANSI_CACHE_MAX_SIZE + 2);
	});
});

describe('clearAnsiCache', () => {
	let mockConverter: { toHtml: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		clearAnsiCache();
		mockConverter = {
			toHtml: vi.fn((text: string) => `<span>${text}</span>`),
		};
	});

	it('empties the cache so previously cached items are recomputed', () => {
		getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(1);

		clearAnsiCache();

		// Should need to recompute after clearing
		getCachedAnsiHtml('hello', 'dark', mockConverter as never);
		expect(mockConverter.toHtml).toHaveBeenCalledTimes(2);
	});

	it('can be called multiple times safely', () => {
		clearAnsiCache();
		clearAnsiCache();
		clearAnsiCache();
		// Should not throw
	});
});
