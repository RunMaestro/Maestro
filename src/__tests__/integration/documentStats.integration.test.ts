import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	countLines,
	countWords,
	extractContentPreview,
	extractDescription,
	extractTitle,
	formatFileSize,
} from '../../renderer/utils/documentStats';

describe('documentStats integration', () => {
	afterEach(() => {
		vi.doUnmock('../../renderer/utils/markdownLinkParser');
		vi.doUnmock('../../renderer/utils/logger');
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it('handles browser path fallbacks, invalid sizes, and blank content helpers', () => {
		expect(extractTitle('', '', {})).toBe('');
		expect(extractTitle('', 'README', {})).toBe('README');
		expect(extractTitle('', '.gitignore', {})).toBe('.gitignore');
		expect(extractTitle('# Heading', 'fallback.md', { title: 'Front Matter Title' })).toBe(
			'Front Matter Title'
		);
		expect(extractDescription({ overview: 'Overview description' })).toBe('Overview description');
		expect(formatFileSize(-1)).toBe('0 B');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(countWords(' \n\t ')).toBe(0);
		expect(countLines('')).toBe(0);
		expect(countLines(' \n\t ')).toBe(0);
		expect(countLines('one\ntwo\n')).toBe(2);
		expect(extractContentPreview('', 'Empty')).toBeUndefined();
		expect(extractContentPreview('short', 'Other')).toBeUndefined();
		expect(extractContentPreview(`Long Title\n${'a'.repeat(700)}`, 'Long Title')).toBe(
			'a'.repeat(600)
		);
	});

	it('computes stats while falling back from unexpected parser and string-operation failures', async () => {
		const loggerWarn = vi.fn();
		vi.resetModules();
		vi.doMock('../../renderer/utils/logger', () => ({
			logger: {
				warn: loggerWarn,
			},
		}));
		vi.doMock('../../renderer/utils/markdownLinkParser', () => ({
			parseMarkdownLinks: vi.fn(() => {
				throw new Error('parser failed');
			}),
		}));

		const { computeDocumentStats: computeWithThrowingParser } =
			await import('../../renderer/utils/documentStats');

		const parserFallback = computeWithThrowingParser(
			'# Fallback\n\nBody content.',
			'parser.md',
			24
		);

		expect(parserFallback).toMatchObject({
			title: 'Fallback',
			description: undefined,
			lineCount: 3,
			wordCount: 4,
			filePath: 'parser.md',
		});
		expect(loggerWarn).toHaveBeenCalledWith(
			'Unexpected error parsing front matter in parser.md:',
			undefined,
			expect.any(Error)
		);

		vi.doUnmock('../../renderer/utils/markdownLinkParser');
		vi.resetModules();
		loggerWarn.mockClear();

		const hostileContent = {
			match: () => {
				throw new Error('match failed');
			},
			trim: () => {
				throw new Error('trim failed');
			},
			replace: () => {
				throw new Error('replace failed');
			},
		};

		const { computeDocumentStats: computeWithHostileContent } =
			await import('../../renderer/utils/documentStats');
		const fallback = computeWithHostileContent(
			hostileContent as unknown as string,
			'bad-content.md',
			12
		);

		expect(fallback).toMatchObject({
			title: 'bad-content',
			lineCount: 0,
			wordCount: 0,
			size: '12 B',
			contentPreview: undefined,
			filePath: 'bad-content.md',
		});
		expect(loggerWarn).toHaveBeenCalledWith(
			'Failed to extract title from bad-content.md:',
			undefined,
			expect.any(Error)
		);
		expect(loggerWarn).toHaveBeenCalledWith(
			'Failed to count lines in bad-content.md:',
			undefined,
			expect.any(Error)
		);
		expect(loggerWarn).toHaveBeenCalledWith(
			'Failed to count words in bad-content.md:',
			undefined,
			expect.any(Error)
		);
		expect(loggerWarn).toHaveBeenCalledWith(
			'Failed to extract content preview from bad-content.md:',
			undefined,
			expect.any(Error)
		);
	});
});
