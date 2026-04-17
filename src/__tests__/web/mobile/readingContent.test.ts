import { describe, expect, it } from 'vitest';
import {
	normalizeWebReaderContent,
	parseTextWithCodeBlocks,
	type WebReaderTextSegment,
} from '../../../web/mobile/readingContent';

describe('normalizeWebReaderContent', () => {
	it('keeps pre-structured segments without reparsing', () => {
		const segments: WebReaderTextSegment[] = [
			{ type: 'text', content: 'Intro' },
			{ type: 'code', content: 'const value = 1;', language: 'typescript' },
		];

		expect(normalizeWebReaderContent(segments)).toEqual({
			kind: 'structured',
			segments,
		});
	});

	it('routes markdown-looking content through markdown rendering', () => {
		expect(normalizeWebReaderContent('# Heading\n\n- item one\n- item two')).toEqual({
			kind: 'markdown',
			markdown: '# Heading\n\n- item one\n- item two',
		});
	});

	it('falls back to structured text when raw content is not markdown', () => {
		expect(normalizeWebReaderContent('line one\nline two\n```ts\nconst value = 1;\n```')).toEqual({
			kind: 'structured',
			segments: [
				{ type: 'text', content: 'line one\nline two\n' },
				{ type: 'code', content: 'const value = 1;', language: 'typescript' },
			],
		});
	});

	it('avoids markdown mode when fenced markdown is incomplete', () => {
		expect(normalizeWebReaderContent('# Heading\n```ts\nconst value = 1;')).toEqual({
			kind: 'structured',
			segments: [{ type: 'text', content: '# Heading\n```ts\nconst value = 1;' }],
		});
	});

	it('parses fenced code blocks that use more than three backticks', () => {
		expect(parseTextWithCodeBlocks('intro\n````ts\nconst value = `code`;\n````\noutro')).toEqual([
			{ type: 'text', content: 'intro\n' },
			{ type: 'code', content: 'const value = `code`;', language: 'typescript' },
			{ type: 'text', content: '\noutro' },
		]);
	});
});
