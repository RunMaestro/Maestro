// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/textProcessing.test.ts
// Source: src/__tests__/renderer/utils/transcriptMessages.test.ts
// Source: src/__tests__/renderer/utils/windowTargets.test.ts
// Source: src/__tests__/renderer/utils/wizardActivity.test.ts
// Source: src/__tests__/renderer/utils/worktreeDedup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	processCarriageReturns,
	processLogTextHelper,
	filterTextByLinesHelper,
	stripMarkdown,
	ANSI_CACHE_MAX_SIZE,
	getCachedAnsiHtml,
	clearAnsiCache,
} from '../../../renderer/utils/textProcessing';
import type { LogEntry } from '../../../renderer/types';
import {
	isSynopsisRequest,
	selectOlderEntries,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../../../renderer/utils/transcriptMessages';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import {
	buildGroupWindowMoveTargets,
	collectGroupAgentIds,
	resolveOwningWindowId,
	buildWindowMoveTargets,
	scopeSessionsToOwningWindow,
	MAIN_WINDOW_LABEL,
} from '../../../renderer/utils/windowTargets';
import type { WindowInfo } from '../../../shared/window-types';
import {
	isWizardTab,
	rollUpWizardActivityToSessions,
	NO_WIZARD_TABS,
	type WizardTabActivity,
} from '../../../renderer/utils/wizardActivity';
import type { Session as S4_Session, AITab } from '../../../renderer/types';
import type { Session as S5_Session } from '../../../renderer/types';
import {
	markWorktreePathAsRecentlyCreated,
	clearRecentlyCreatedWorktreePath,
	isRecentlyCreatedWorktreePath,
	normalizePath,
	sessionMatchesWorktreeRoot,
} from '../../../renderer/utils/worktreeDedup';
vi.mock('dompurify', () => ({
	default: { sanitize: vi.fn((html: string) => html) },
}));
// Source: src/__tests__/renderer/utils/textProcessing.test.ts
describe('', () => {
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
		const sampleText =
			'Error: file not found\nWarning: low memory\nInfo: process started\nError: timeout';
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
		it('removes multi-line markdown tables entirely', () => {
			const input = [
				'Summary:',
				'',
				'| Step | Result |',
				'|------|--------|',
				'| 1. Build | Pass |',
			].join('\n');
			// Table rows/separator are dropped; only the prose lines remain.
			expect(stripMarkdown(input).replace(/\n+/g, '\n').trim()).toBe('Summary:');
		});
		it('collapses a table that was flattened onto one line', () => {
			// Mirrors a stored History summary where newlines were already squashed.
			const input = 'All four steps complete. Summary: | Step | Result | |------|--------| |';
			const out = stripMarkdown(input).replace(/\s+/g, ' ').trim();
			expect(out).toBe('All four steps complete. Summary:');
			expect(out).not.toContain('|');
		});
		it('leaves prose with fewer than three pipes untouched', () => {
			expect(stripMarkdown('choose a | b')).toBe('choose a | b');
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
		let mockConverter: {
			toHtml: ReturnType<typeof vi.fn>;
		};
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
		let mockConverter: {
			toHtml: ReturnType<typeof vi.fn>;
		};
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
});
// Source: src/__tests__/renderer/utils/transcriptMessages.test.ts
describe('', () => {
	function entry(id: string, text: string, source: LogEntry['source'] = 'user', ts = 0): LogEntry {
		return { id, text, source, timestamp: ts };
	}
	function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
		return {
			type: 'user',
			content: 'hello',
			timestamp: '2026-01-01T00:00:00.000Z',
			uuid: 'uuid-1',
			...overrides,
		};
	}
	describe('transcriptMessagesToLogEntries', () => {
		it('keeps messages with text and maps user vs assistant to log sources', () => {
			const entries = transcriptMessagesToLogEntries([
				message({ uuid: 'a', type: 'user', content: 'question' }),
				message({ uuid: 'b', type: 'assistant', content: 'answer' }),
			]);
			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({ id: 'a', text: 'question', source: 'user' });
			expect(entries[1]).toMatchObject({ id: 'b', text: 'answer', source: 'stdout' });
		});
		it('drops tool-only messages but keeps image-only ones', () => {
			const entries = transcriptMessagesToLogEntries([
				message({ uuid: 'tool', content: '   ' }),
				message({ uuid: 'img', content: '', images: ['data:image/png;base64,AAA'] }),
			]);
			expect(entries.map((e) => e.id)).toEqual(['img']);
			expect(entries[0].images).toEqual(['data:image/png;base64,AAA']);
		});
		// Issue #1533: every provider but Claude Code takes Maestro's system prompt
		// embedded in the first user turn, and that turn is what lands on disk. A
		// hydrated tab used to render the whole envelope as if the user had typed it.
		it('unwraps the embedded system prompt from a hydrated user turn', () => {
			const wrapped = embedSystemPromptInPrompt(
				'# Maestro System Context\n\nYou are **Scout**, working in /repo.',
				'run the test suite'
			);
			const entries = transcriptMessagesToLogEntries([
				message({ uuid: 'u', type: 'user', content: wrapped }),
			]);
			expect(entries[0].text).toBe('run the test suite');
			expect(entries[0].text).not.toContain('Maestro System Context');
		});
		it('drops a turn that carried nothing but the envelope', () => {
			const entries = transcriptMessagesToLogEntries([
				message({
					uuid: 'sys',
					type: 'user',
					content: embedSystemPromptInPrompt('# Context', ''),
				}),
				message({ uuid: 'a', type: 'assistant', content: 'done' }),
			]);
			expect(entries.map((e) => e.id)).toEqual(['a']);
		});
		it('leaves an assistant message that quotes the marker alone', () => {
			// Only a user turn is ever wrapped, and an agent explaining the format
			// must not have its answer truncated.
			const quoted = 'The spawn path sends:\n\n---\n\n# User Request\n\n<your prompt>';
			const entries = transcriptMessagesToLogEntries([
				message({ uuid: 'a', type: 'assistant', content: quoted }),
			]);
			expect(entries[0].text).toBe(quoted);
		});
		// The backfill matches a hydrated entry against what the live tab logged to
		// find its splice point, and a live tab logs the CLEAN prompt. Unwrapping is
		// what lets those two texts line up at all.
		it('produces a first turn that matches the entry a live tab logged', () => {
			const wrapped = embedSystemPromptInPrompt('# Maestro System Context', 'fix the flaky test');
			const loaded = transcriptMessagesToLogEntries([
				message({ uuid: 'disk-1', type: 'user', content: wrapped }),
				message({ uuid: 'disk-2', type: 'assistant', content: 'on it' }),
			]);
			const visible = [entry('live-2', 'on it', 'stdout')];
			expect(selectOlderEntries(loaded, visible).map((e) => e.text)).toEqual([
				'fix the flaky test',
			]);
		});
	});
	describe('stripSynopsisTurns', () => {
		it('removes the Auto Run synopsis request and the reply that follows it', () => {
			const kept = stripSynopsisTurns([
				message({ uuid: 'a', content: 'real question' }),
				message({
					uuid: 'b',
					content: 'Give a brief synopsis of what you just accomplished',
				}),
				message({ uuid: 'c', type: 'assistant', content: '**Summary:** did things' }),
				message({ uuid: 'd', type: 'assistant', content: 'real answer' }),
			]);
			expect(kept.map((m) => m.uuid)).toEqual(['a', 'd']);
		});
		it('only treats user turns as synopsis requests', () => {
			expect(
				isSynopsisRequest({
					type: 'assistant',
					content: 'Give a brief synopsis of what you just accomplished',
				})
			).toBe(false);
		});
	});
	describe('selectOlderEntries', () => {
		it('returns everything when the tab is empty', () => {
			const loaded = [entry('1', 'a'), entry('2', 'b')];
			expect(selectOlderEntries(loaded, [])).toEqual(loaded);
		});
		it('prepends only what sits above the first visible entry, matched by id', () => {
			const loaded = [entry('1', 'a'), entry('2', 'b'), entry('3', 'c'), entry('4', 'd')];
			const visible = [entry('3', 'c'), entry('4', 'd')];
			expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2']);
		});
		it('falls back to source+text when the tab holds locally generated ids', () => {
			// The restart path: same conversation, but the visible entries were built
			// live so their ids do not match the on-disk uuids.
			const loaded = [entry('u1', 'a'), entry('u2', 'b'), entry('u3', 'c')];
			const visible = [entry('local-x', 'c'), entry('local-y', 'd')];
			expect(selectOlderEntries(loaded, visible).map((e) => e.text)).toEqual(['a', 'b']);
		});
		it('returns nothing when the visible tab already starts at the first message', () => {
			const loaded = [entry('1', 'a'), entry('2', 'b')];
			const visible = [entry('1', 'a'), entry('2', 'b')];
			expect(selectOlderEntries(loaded, visible)).toEqual([]);
		});
		it('picks the boundary nearest the expected splice point when text repeats', () => {
			// "continue" appears three times. The window is 6 long and the tab shows the
			// newest 3, so the real boundary is index 3 - not the first or last match.
			const loaded = [
				entry('1', 'continue'),
				entry('2', 'work'),
				entry('3', 'continue'),
				entry('4', 'continue'),
				entry('5', 'more'),
				entry('6', 'done'),
			];
			const visible = [entry('x', 'continue'), entry('y', 'more'), entry('z', 'done')];
			expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2', '3']);
		});
		// The expected splice point is only an estimate: it is off by however many
		// renderer-only entries the tab holds (system notices, outage markers). Push
		// that estimate past one repetition of a repeated message and the NEAREST
		// source+text hit is the wrong occurrence, which silently drops the genuine
		// older turns between the two. A match needs corroboration, not just proximity.
		it('prefers the occurrence whose timestamp matches over a nearer text-only hit', () => {
			const loaded = [
				entry('1', 'start', 'user', 0),
				entry('2', 'continue', 'user', 100),
				entry('3', 'work', 'user', 200),
				entry('4', 'continue', 'user', 300),
				entry('5', 'more', 'user', 400),
				entry('6', 'done', 'user', 500),
			];
			// Tab was hydrated from disk (timestamps survive) but holds two
			// renderer-only notices, so expected lands on index 1 - the WRONG
			// "continue". The timestamp pins the real boundary at index 3.
			const visible = [
				entry('local-a', 'continue', 'user', 300),
				entry('sys-1', 'Agent reconnected', 'system', 310),
				entry('sys-2', 'Retrying', 'system', 320),
				entry('local-b', 'more', 'user', 400),
				entry('local-c', 'done', 'user', 500),
			];
			expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2', '3']);
		});
		it('prefers the occurrence whose following entry also lines up', () => {
			const loaded = [
				entry('1', 'start', 'user', 0),
				entry('2', 'continue', 'user', 100),
				entry('3', 'work', 'user', 200),
				entry('4', 'continue', 'user', 300),
				entry('5', 'more', 'user', 400),
				entry('6', 'done', 'user', 500),
			];
			// The restart path: local ids AND renderer clock timestamps, so neither id
			// nor timestamp can pick between the two "continue" entries. The entry that
			// FOLLOWS the boundary is what breaks the tie.
			const visible = [
				entry('local-a', 'continue', 'user', 9001),
				entry('local-b', 'more', 'user', 9002),
				entry('local-c', 'done', 'user', 9003),
				entry('sys-1', 'Agent reconnected', 'system', 9004),
				entry('sys-2', 'Retrying', 'system', 9005),
			];
			expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2', '3']);
		});
		it('still takes the nearest match when nothing corroborates either occurrence', () => {
			// No timestamps, no usable next entry: fall back to proximity, which is the
			// best guess available and the behavior every non-repeating case relies on.
			const loaded = [entry('1', 'continue'), entry('2', 'work'), entry('3', 'continue')];
			const visible = [entry('local-a', 'continue')];
			expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2']);
		});
		it('cuts on timestamp when the boundary entry never reached disk', () => {
			// Maestro-injected system notices live only in the tab, so there is nothing
			// on disk to match. Anything strictly older than it is still safe to prepend.
			const loaded = [entry('1', 'a', 'user', 100), entry('2', 'b', 'user', 300)];
			const visible = [entry('sys', 'Agent reconnected', 'system', 200)];
			expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1']);
		});
	});
});
// Source: src/__tests__/renderer/utils/windowTargets.test.ts
describe('', () => {
	function makeInfo(partial: Partial<WindowInfo> & Pick<WindowInfo, 'id'>): WindowInfo {
		return { isMain: false, sessionIds: [], activeSessionId: null, ...partial };
	}
	describe('buildWindowMoveTargets', () => {
		it('returns [] before the registry has hydrated (single-window common case)', () => {
			expect(buildWindowMoveTargets([], 'a')).toEqual([]);
		});
		it('labels the primary "Main Window" and each secondary by its window number', () => {
			const windows = [
				makeInfo({ id: 'primary', isMain: true }),
				// Secondary borrows NO agent name - it is a numbered container.
				makeInfo({ id: 'win-2', sessionIds: ['b', 'c'] }),
				makeInfo({ id: 'win-3', sessionIds: ['d'] }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			expect(targets.map((t) => t.label)).toEqual([MAIN_WINDOW_LABEL, 'Window 2', 'Window 3']);
			expect(targets.map((t) => t.windowNumber)).toEqual([1, 2, 3]);
		});
		it('flags the primary as current owner for a catch-all (unclaimed) agent', () => {
			const windows = [
				makeInfo({ id: 'primary', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['b'] }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			// 'a' is claimed by no secondary, so the primary catch-all owns it.
			expect(targets.find((t) => t.isMain)?.isCurrentOwner).toBe(true);
			expect(targets.find((t) => t.windowId === 'win-2')?.isCurrentOwner).toBe(false);
		});
		it('flags the claiming secondary as current owner, not the primary', () => {
			const windows = [
				makeInfo({ id: 'primary', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['a'] }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			expect(targets.find((t) => t.isMain)?.isCurrentOwner).toBe(false);
			expect(targets.find((t) => t.windowId === 'win-2')?.isCurrentOwner).toBe(true);
		});
		it('uses a custom window name as the label (and exposes it as customName)', () => {
			const windows = [
				makeInfo({ id: 'primary', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['b'], name: 'Deploy Watch' }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			const secondary = targets.find((t) => t.windowId === 'win-2')!;
			// Custom name wins over the generic "Window 2" label.
			expect(secondary.label).toBe('Deploy Watch');
			expect(secondary.customName).toBe('Deploy Watch');
		});
		it('a custom name on the primary overrides "Main Window"', () => {
			const windows = [makeInfo({ id: 'primary', isMain: true, name: 'Home Base' })];
			const targets = buildWindowMoveTargets(windows, 'a');
			expect(targets[0].label).toBe('Home Base');
		});
		it('labels an unnamed secondary by its number regardless of the agents it holds', () => {
			const windows = [
				makeInfo({ id: 'primary', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['some-agent'] }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			expect(targets.find((t) => t.windowId === 'win-2')?.label).toBe('Window 2');
		});
		it('truncates a long custom name with an end ellipsis', () => {
			const longName = 'A'.repeat(60);
			const windows = [
				makeInfo({ id: 'primary', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['b'], name: longName }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			const label = targets.find((t) => t.windowId === 'win-2')!.label;
			expect(label.length).toBeLessThan(longName.length);
			expect(label.endsWith('…')).toBe(true);
		});
		it('omits an empty secondary window (it is auto-closing, not a destination)', () => {
			const windows = [
				makeInfo({ id: 'primary', isMain: true, sessionIds: ['a'] }),
				makeInfo({ id: 'win-2', sessionIds: [] }), // just lost its last agent
				makeInfo({ id: 'win-3', sessionIds: ['b'] }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			expect(targets.map((t) => t.windowId)).toEqual(['primary', 'win-3']);
			// windowNumber stays the registry-order index, so win-3 is still "Window 3"
			// (matching its OS title) even though the empty win-2 was skipped.
			expect(targets.find((t) => t.windowId === 'win-3')?.windowNumber).toBe(3);
			expect(targets.find((t) => t.windowId === 'win-3')?.label).toBe('Window 3');
		});
		it('keeps the primary even when it is the catch-all owner of zero explicit agents', () => {
			// The primary never auto-closes, so it is always a valid destination.
			const windows = [
				makeInfo({ id: 'primary', isMain: true, sessionIds: [] }),
				makeInfo({ id: 'win-2', sessionIds: ['a'] }),
			];
			const targets = buildWindowMoveTargets(windows, 'a');
			expect(targets.some((t) => t.isMain)).toBe(true);
		});
	});
	describe('scopeSessionsToOwningWindow', () => {
		interface S {
			id: string;
			parentSessionId?: string | null;
		}
		const list: S[] = [
			{ id: 'a' },
			{ id: 'b' },
			{ id: 'c' },
			{ id: 'a-wt', parentSessionId: 'a' }, // worktree child of a
			{ id: 'b-wt', parentSessionId: 'b' }, // worktree child of b
		];
		it('returns the list unchanged when there is no ownsSession (no WindowProvider)', () => {
			expect(scopeSessionsToOwningWindow(list, null)).toBe(list);
		});
		it('is a no-op when ownsSession owns everything (single-window primary)', () => {
			const scoped = scopeSessionsToOwningWindow(list, () => true).map((s) => s.id);
			expect(scoped).toEqual(['a', 'b', 'c', 'a-wt', 'b-wt']);
		});
		it('keeps only owned agents (applies to primary and secondary alike)', () => {
			const owns = (id: string) => id === 'a';
			const scoped = scopeSessionsToOwningWindow(list, owns).map((s) => s.id);
			// 'a' is owned; 'a-wt' rides along as its worktree child. b/c and b-wt drop.
			expect(scoped).toEqual(['a', 'a-wt']);
		});
		it('drops an agent owned by another window from this window (primary loses a moved agent)', () => {
			// Primary ownsSession = "not claimed by a secondary". Say 'b' moved to a
			// secondary window, so the primary no longer owns it.
			const owns = (id: string) => id !== 'b' && id !== 'b-wt';
			const scoped = scopeSessionsToOwningWindow(list, owns).map((s) => s.id);
			expect(scoped).toEqual(['a', 'c', 'a-wt']);
		});
		it('keeps a worktree child whose parent is owned, even if the child id is not', () => {
			// Ownership is recorded per-agent; a moved parent should keep its worktrees.
			const owns = (id: string) => id === 'b';
			const scoped = scopeSessionsToOwningWindow(list, owns).map((s) => s.id);
			expect(scoped).toEqual(['b', 'b-wt']);
		});
	});
	describe('group window moves', () => {
		const windows: WindowInfo[] = [
			makeInfo({ id: 'p', isMain: true }),
			makeInfo({ id: 'w2', sessionIds: ['b'] }),
		];
		it('resolves an agent to its claiming secondary, else the primary', () => {
			expect(resolveOwningWindowId(windows, 'b')).toBe('w2');
			expect(resolveOwningWindowId(windows, 'a')).toBe('p');
			expect(resolveOwningWindowId([], 'a')).toBeNull();
		});
		it('marks a window as the owner only when it holds EVERY agent in the group', () => {
			const split = buildGroupWindowMoveTargets(windows, ['a', 'b']);
			expect(split.map((t) => [t.windowId, t.isCurrentOwner])).toEqual([
				['p', false],
				['w2', false],
			]);
			const whole = buildGroupWindowMoveTargets(windows, ['b']);
			expect(whole.find((t) => t.windowId === 'w2')?.isCurrentOwner).toBe(true);
		});
		it('offers nothing for an empty group', () => {
			expect(buildGroupWindowMoveTargets(windows, [])).toEqual([]);
		});
		it('collects top-level members, adding subgroups only when asked', () => {
			const sessions = [
				{ id: 'a', groupId: 'g' },
				{ id: 'wt', groupId: 'g', parentSessionId: 'a' },
				{ id: 'c', groupId: 'child' },
				{ id: 'x', groupId: 'other' },
				{ id: 'u' },
			];
			const groups = [
				{ id: 'g' },
				{ id: 'child', parentGroupId: 'g' },
				{ id: 'other' },
				// A malformed cycle must not loop forever.
				{ id: 'loop1', parentGroupId: 'loop2' },
				{ id: 'loop2', parentGroupId: 'loop1' },
			];
			expect(collectGroupAgentIds(sessions, groups, 'g', false)).toEqual(['a']);
			expect(collectGroupAgentIds(sessions, groups, 'g', true)).toEqual(['a', 'c']);
			expect(collectGroupAgentIds(sessions, groups, 'loop1', true)).toEqual([]);
		});
	});
});
// Source: src/__tests__/renderer/utils/wizardActivity.test.ts
describe('', () => {
	const tab = (id: string) => ({ id }) as AITab;
	const session = (id: string, tabIds: string[], overrides: Partial<S4_Session> = {}): S4_Session =>
		({ id, aiTabs: tabIds.map(tab), ...overrides }) as S4_Session;
	const activity = (
		entries: Array<[string, WizardTabActivity]>
	): ReadonlyMap<string, WizardTabActivity> => new Map(entries);
	describe('isWizardTab', () => {
		it('reports tabs present in the activity map', () => {
			const map = activity([['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }]]);
			expect(isWizardTab(map, 'tab-1')).toBe(true);
			expect(isWizardTab(map, 'tab-2')).toBe(false);
		});
		it('is false for a missing tab id rather than throwing', () => {
			expect(isWizardTab(NO_WIZARD_TABS, undefined)).toBe(false);
			expect(isWizardTab(NO_WIZARD_TABS, null)).toBe(false);
		});
	});
	describe('rollUpWizardActivityToSessions', () => {
		it('maps a live wizard tab to its owning agent', () => {
			const result = rollUpWizardActivityToSessions(
				activity([['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }]]),
				[session('agent-1', ['tab-1'])]
			);
			expect(result.get('agent-1')).toEqual({ isGeneratingDocs: false });
		});
		it('drops entries whose tab is no longer open', () => {
			// The phantom-wand case: the wizard was never evicted from the hook map, but its
			// tab is gone. No wand, because there is nothing left to switch to.
			const result = rollUpWizardActivityToSessions(
				activity([['closed-tab', { sessionId: 'agent-1', isGeneratingDocs: true }]]),
				[session('agent-1', ['tab-1'])]
			);
			expect(result.size).toBe(0);
		});
		it('drops entries whose agent is gone entirely', () => {
			const result = rollUpWizardActivityToSessions(
				activity([['tab-1', { sessionId: 'deleted-agent', isGeneratingDocs: false }]]),
				[session('agent-1', ['tab-1'])]
			);
			expect(result.size).toBe(0);
		});
		it('does not count a snoozed wizard tab', () => {
			// A snoozed tab is out of the strip, so a wand on the agent row points at nothing.
			const result = rollUpWizardActivityToSessions(
				activity([['snoozed-tab', { sessionId: 'agent-1', isGeneratingDocs: false }]]),
				[
					session('agent-1', ['tab-1'], {
						snoozedTabs: [{ id: 'snooze-1', tab: tab('snoozed-tab') }],
					} as Partial<S4_Session>),
				]
			);
			expect(result.size).toBe(0);
		});
		it('ORs isGeneratingDocs across an agent with several wizard tabs', () => {
			const result = rollUpWizardActivityToSessions(
				activity([
					['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }],
					['tab-2', { sessionId: 'agent-1', isGeneratingDocs: true }],
				]),
				[session('agent-1', ['tab-1', 'tab-2'])]
			);
			expect(result.get('agent-1')).toEqual({ isGeneratingDocs: true });
		});
		it('ignores a generating tab that is closed while a live one is not generating', () => {
			const result = rollUpWizardActivityToSessions(
				activity([
					['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }],
					['closed-tab', { sessionId: 'agent-1', isGeneratingDocs: true }],
				]),
				[session('agent-1', ['tab-1'])]
			);
			expect(result.get('agent-1')).toEqual({ isGeneratingDocs: false });
		});
		it('skips entries with no owning agent recorded', () => {
			const result = rollUpWizardActivityToSessions(
				activity([['tab-1', { sessionId: null, isGeneratingDocs: false }]]),
				[session('agent-1', ['tab-1'])]
			);
			expect(result.size).toBe(0);
		});
		it('returns an empty map when nothing is running', () => {
			expect(
				rollUpWizardActivityToSessions(NO_WIZARD_TABS, [session('agent-1', ['tab-1'])]).size
			).toBe(0);
		});
	});
});
// Source: src/__tests__/renderer/utils/worktreeDedup.test.ts
describe('', () => {
	describe('worktreeDedup', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			// Clean up any marked paths by advancing past TTL
			vi.advanceTimersByTime(20000);
			vi.useRealTimers();
		});
		it('marks a path as recently created', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/feature-x');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/feature-x')).toBe(true);
		});
		it('returns false for unmarked paths', () => {
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/nonexistent')).toBe(false);
		});
		it('normalizes paths for comparison (trailing slashes)', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/feature-x/');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/feature-x')).toBe(true);
		});
		it('normalizes paths for comparison (backslashes)', () => {
			markWorktreePathAsRecentlyCreated('C:\\projects\\worktrees\\feature-x');
			expect(isRecentlyCreatedWorktreePath('C:/projects/worktrees/feature-x')).toBe(true);
		});
		it('normalizes paths for comparison (duplicate slashes)', () => {
			markWorktreePathAsRecentlyCreated('/projects//worktrees///feature-x');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/feature-x')).toBe(true);
		});
		it('clears a previously marked path', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/to-clear');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/to-clear')).toBe(true);
			clearRecentlyCreatedWorktreePath('/projects/worktrees/to-clear');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/to-clear')).toBe(false);
		});
		it('auto-expires after TTL (default 10s)', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/ttl-test');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/ttl-test')).toBe(true);
			// Just before TTL
			vi.advanceTimersByTime(9999);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/ttl-test')).toBe(true);
			// At TTL
			vi.advanceTimersByTime(1);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/ttl-test')).toBe(false);
		});
		it('supports custom TTL', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/custom-ttl', 5000);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/custom-ttl')).toBe(true);
			vi.advanceTimersByTime(5000);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/custom-ttl')).toBe(false);
		});
		it('handles multiple concurrent paths independently', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/a');
			markWorktreePathAsRecentlyCreated('/projects/worktrees/b');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/a')).toBe(true);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/b')).toBe(true);
			clearRecentlyCreatedWorktreePath('/projects/worktrees/a');
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/a')).toBe(false);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/b')).toBe(true);
		});
		it('re-marking a path resets the TTL timer', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/remark', 10000);
			// Advance 8s (within original TTL)
			vi.advanceTimersByTime(8000);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/remark')).toBe(true);
			// Re-mark - should reset the 10s TTL
			markWorktreePathAsRecentlyCreated('/projects/worktrees/remark', 10000);
			// Advance another 8s (16s total, past original TTL but within re-marked TTL)
			vi.advanceTimersByTime(8000);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/remark')).toBe(true);
			// Advance past re-marked TTL
			vi.advanceTimersByTime(2001);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/remark')).toBe(false);
		});
		it('clearRecentlyCreatedWorktreePath cancels pending timer', () => {
			markWorktreePathAsRecentlyCreated('/projects/worktrees/clear-timer', 10000);
			clearRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer');
			// Re-mark with a short TTL
			markWorktreePathAsRecentlyCreated('/projects/worktrees/clear-timer', 5000);
			// Advance past original TTL but within new TTL - should still be present
			// (old timer was cleared, only new 5s timer exists)
			vi.advanceTimersByTime(4999);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer')).toBe(true);
			vi.advanceTimersByTime(1);
			expect(isRecentlyCreatedWorktreePath('/projects/worktrees/clear-timer')).toBe(false);
		});
	});
	describe('normalizePath', () => {
		it('converts backslashes to forward slashes', () => {
			expect(normalizePath('C:\\Users\\test\\repo')).toBe('C:/Users/test/repo');
		});
		it('collapses duplicate slashes', () => {
			expect(normalizePath('/a//b///c')).toBe('/a/b/c');
		});
		it('preserves UNC identity while keeping root-relative paths distinct', () => {
			const uncPath = normalizePath('\\\\server\\share\\repo');
			const rootRelativePath = normalizePath('\\server\\share\\repo');
			expect(uncPath).toBe('//server/share/repo');
			expect(rootRelativePath).toBe('/server/share/repo');
			expect(uncPath).not.toBe(rootRelativePath);
		});
		it('strips trailing slash', () => {
			expect(normalizePath('/projects/worktrees/feature/')).toBe('/projects/worktrees/feature');
		});
		it('handles mixed separators, duplicates, and trailing slash together', () => {
			expect(normalizePath('C:\\Users//test\\\\repo/')).toBe('C:/Users/test/repo');
		});
		it('returns empty string unchanged', () => {
			expect(normalizePath('')).toBe('');
		});
		it.each([
			['/', false, '/'],
			['C:\\', false, 'C:/'],
			['\\\\server\\share\\repo\\', false, '//server/share/repo'],
			['//server//share/repo/', true, '/server/share/repo'],
			['/trees/feature\\name/', true, '/trees/feature\\name'],
			['/', true, '/'],
		] as const)('normalizes %s with POSIX mode %s', (input, posix, expected) => {
			expect(normalizePath(input, posix)).toBe(expected);
		});
	});
	describe('sessionMatchesWorktreeRoot', () => {
		const root = '/projects/worktrees/feature-x';
		function makeSession(overrides: Partial<S5_Session>): S5_Session {
			return {
				id: 'sess-1',
				cwd: '',
				...overrides,
			} as S5_Session;
		}
		it('matches on projectRoot exact equality', () => {
			const s = makeSession({ projectRoot: root, cwd: '/elsewhere' });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
		});
		it('matches on cwd exact equality when projectRoot is unset', () => {
			const s = makeSession({ cwd: root });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
		});
		it('matches projectRoot with trailing slash via normalization', () => {
			const s = makeSession({ projectRoot: `${root}/`, cwd: '/elsewhere' });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
		});
		it('matches projectRoot with backslashes via normalization', () => {
			const s = makeSession({ projectRoot: 'C:\\projects\\worktrees\\feature-x' });
			expect(sessionMatchesWorktreeRoot(s, 'C:/projects/worktrees/feature-x')).toBe(true);
		});
		it('does NOT match a session whose cwd is a subdir of the worktree root', () => {
			// projectRoot fallback exists precisely so this case still matches via
			// projectRoot - but if projectRoot is missing, cwd-only must NOT match.
			const s = makeSession({ cwd: `${root}/src/components` });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(false);
		});
		it('matches via projectRoot even when cwd has drifted into a subdir', () => {
			const s = makeSession({ projectRoot: root, cwd: `${root}/src/components` });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(true);
		});
		it('returns false when neither projectRoot nor cwd is set', () => {
			const s = makeSession({ cwd: '' });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(false);
		});
		it('returns false for a different worktree root', () => {
			const s = makeSession({ projectRoot: '/projects/worktrees/other' });
			expect(sessionMatchesWorktreeRoot(s, root)).toBe(false);
		});
	});
});
