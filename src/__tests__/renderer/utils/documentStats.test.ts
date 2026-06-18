/**
 * Tests for document stats utility
 */

import {
	computeDocumentStats,
	formatFileSize,
	countWords,
	countLines,
	extractTitle,
	extractDescription,
	type DocumentStats,
} from '../../../renderer/utils/documentStats';

describe('formatFileSize', () => {
	it('should format bytes', () => {
		expect(formatFileSize(0)).toBe('0 B');
		expect(formatFileSize(100)).toBe('100 B');
		expect(formatFileSize(1023)).toBe('1023 B');
	});

	it('should format kilobytes', () => {
		expect(formatFileSize(1024)).toBe('1.0 KB');
		expect(formatFileSize(1536)).toBe('1.5 KB');
		expect(formatFileSize(10240)).toBe('10.0 KB');
	});

	it('should format megabytes', () => {
		expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
		expect(formatFileSize(1024 * 1024 * 2.5)).toBe('2.5 MB');
	});

	it('should format gigabytes', () => {
		expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
		expect(formatFileSize(1024 * 1024 * 1024 * 3.7)).toBe('3.7 GB');
	});

	it('should handle negative values', () => {
		expect(formatFileSize(-100)).toBe('0 B');
	});
});

describe('countWords', () => {
	it('should count words in simple text', () => {
		expect(countWords('hello world')).toBe(2);
		expect(countWords('one two three four')).toBe(4);
	});

	it('should handle multiple spaces', () => {
		expect(countWords('hello    world')).toBe(2);
	});

	it('should handle tabs and newlines', () => {
		expect(countWords('hello\tworld\nfoo')).toBe(3);
	});

	it('should handle empty content', () => {
		expect(countWords('')).toBe(0);
		expect(countWords('   ')).toBe(0);
		expect(countWords('\n\t\n')).toBe(0);
	});

	it('should count markdown content correctly', () => {
		// Words: #, Heading, This, is, a, paragraph, with, **bold**, text.
		const content = '# Heading\n\nThis is a paragraph with **bold** text.';
		expect(countWords(content)).toBe(9);
	});
});

describe('countLines', () => {
	it('should count lines in simple text', () => {
		expect(countLines('one line')).toBe(1);
		expect(countLines('line one\nline two')).toBe(2);
		expect(countLines('line one\nline two\nline three')).toBe(3);
	});

	it('should handle trailing newline', () => {
		expect(countLines('line one\nline two\n')).toBe(2);
	});

	it('should handle empty content', () => {
		expect(countLines('')).toBe(0);
		expect(countLines('   ')).toBe(0);
	});

	it('should count empty lines', () => {
		expect(countLines('line one\n\nline three')).toBe(3);
	});
});

describe('extractTitle', () => {
	it('should prefer front matter title', () => {
		const content = '# Heading Title\n\nContent here';
		const frontMatter = { title: 'Front Matter Title' };
		expect(extractTitle(content, 'document.md', frontMatter)).toBe('Front Matter Title');
	});

	it('should fall back to H1 heading', () => {
		const content = '# Heading Title\n\nContent here';
		const frontMatter = {};
		expect(extractTitle(content, 'document.md', frontMatter)).toBe('Heading Title');
	});

	it('should handle H1 with extra spaces', () => {
		const content = '#   Heading with Spaces   \n\nContent';
		const frontMatter = {};
		expect(extractTitle(content, 'document.md', frontMatter)).toBe('Heading with Spaces');
	});

	it('should fall back to filename', () => {
		const content = 'Just content, no heading.';
		const frontMatter = {};
		expect(extractTitle(content, 'my-document.md', frontMatter)).toBe('my-document');
	});

	it('should handle paths with directories', () => {
		const content = 'Just content.';
		const frontMatter = {};
		expect(extractTitle(content, 'docs/guide/setup.md', frontMatter)).toBe('setup');
	});

	it('should not match H2 or other headings', () => {
		const content = '## H2 Heading\n\n### H3 Heading';
		const frontMatter = {};
		expect(extractTitle(content, 'document.md', frontMatter)).toBe('document');
	});

	it('should find first H1 even if not at start', () => {
		const content = 'Some intro text.\n\n# The Real Title\n\nMore content.';
		const frontMatter = {};
		expect(extractTitle(content, 'document.md', frontMatter)).toBe('The Real Title');
	});

	it('should skip non-string front matter title', () => {
		const content = '# Heading Title';
		const frontMatter = { title: 123 };
		expect(extractTitle(content, 'document.md', frontMatter)).toBe('Heading Title');
	});
});

describe('extractDescription', () => {
	it('should extract description key', () => {
		const frontMatter = { description: 'This is a description' };
		expect(extractDescription(frontMatter)).toBe('This is a description');
	});

	it('should extract overview key', () => {
		const frontMatter = { overview: 'This is an overview' };
		expect(extractDescription(frontMatter)).toBe('This is an overview');
	});

	it('should extract abstract key', () => {
		const frontMatter = { abstract: 'This is an abstract' };
		expect(extractDescription(frontMatter)).toBe('This is an abstract');
	});

	it('should extract summary key', () => {
		const frontMatter = { summary: 'This is a summary' };
		expect(extractDescription(frontMatter)).toBe('This is a summary');
	});

	it('should extract synopsis key', () => {
		const frontMatter = { synopsis: 'This is a synopsis' };
		expect(extractDescription(frontMatter)).toBe('This is a synopsis');
	});

	it('should extract intro key', () => {
		const frontMatter = { intro: 'This is an intro' };
		expect(extractDescription(frontMatter)).toBe('This is an intro');
	});

	it('should extract introduction key', () => {
		const frontMatter = { introduction: 'This is an introduction' };
		expect(extractDescription(frontMatter)).toBe('This is an introduction');
	});

	it('should extract about key', () => {
		const frontMatter = { about: 'This is about' };
		expect(extractDescription(frontMatter)).toBe('This is about');
	});

	it('should extract tldr key', () => {
		const frontMatter = { tldr: 'This is a tldr' };
		expect(extractDescription(frontMatter)).toBe('This is a tldr');
	});

	it('should extract excerpt key', () => {
		const frontMatter = { excerpt: 'This is an excerpt' };
		expect(extractDescription(frontMatter)).toBe('This is an excerpt');
	});

	it('should extract blurb key', () => {
		const frontMatter = { blurb: 'This is a blurb' };
		expect(extractDescription(frontMatter)).toBe('This is a blurb');
	});

	it('should extract brief key', () => {
		const frontMatter = { brief: 'This is a brief' };
		expect(extractDescription(frontMatter)).toBe('This is a brief');
	});

	it('should extract preamble key', () => {
		const frontMatter = { preamble: 'This is a preamble' };
		expect(extractDescription(frontMatter)).toBe('This is a preamble');
	});

	it('should prefer description over other keys', () => {
		const frontMatter = {
			summary: 'Summary text',
			description: 'Description text',
			overview: 'Overview text',
		};
		expect(extractDescription(frontMatter)).toBe('Description text');
	});

	it('should return undefined when no description key found', () => {
		const frontMatter = { title: 'Some Title', author: 'John' };
		expect(extractDescription(frontMatter)).toBeUndefined();
	});

	it('should skip non-string values', () => {
		const frontMatter = { description: 123, summary: 'Valid summary' };
		expect(extractDescription(frontMatter)).toBe('Valid summary');
	});

	it('should return undefined for empty front matter', () => {
		expect(extractDescription({})).toBeUndefined();
	});
});

describe('computeDocumentStats', () => {
	it('should compute all stats for a complete document', () => {
		const content = `---
title: My Document
description: A test document for stats
---

# Introduction

This is a test document with multiple lines.
It has several words.

## Section One

More content here.
`;
		const result = computeDocumentStats(content, 'docs/my-doc.md', 1536);

		expect(result.title).toBe('My Document');
		expect(result.description).toBe('A test document for stats');
		expect(result.lineCount).toBe(13);
		// Word count includes front matter (---, title:, etc.) and markdown symbols (#, ##)
		expect(result.wordCount).toBe(31);
		expect(result.size).toBe('1.5 KB');
		expect(result.filePath).toBe('docs/my-doc.md');
	});

	it('should compute stats without front matter', () => {
		const content = `# Document Title

Some content here.
`;
		const result = computeDocumentStats(content, 'readme.md', 512);

		expect(result.title).toBe('Document Title');
		expect(result.description).toBeUndefined();
		expect(result.lineCount).toBe(3);
		// Words: #, Document, Title, Some, content, here.
		expect(result.wordCount).toBe(6);
		expect(result.size).toBe('512 B');
		expect(result.filePath).toBe('readme.md');
	});

	it('should use filename when no title available', () => {
		const content = 'Just some content without a heading.';
		const result = computeDocumentStats(content, 'notes/my-notes.md', 256);

		expect(result.title).toBe('my-notes');
	});

	it('should handle empty content', () => {
		const content = '';
		const result = computeDocumentStats(content, 'empty.md', 0);

		expect(result.title).toBe('empty');
		expect(result.lineCount).toBe(0);
		expect(result.wordCount).toBe(0);
		expect(result.size).toBe('0 B');
		expect(result.description).toBeUndefined();
	});

	it('should handle different description keys', () => {
		const content = `---
title: Doc
overview: This is the overview
---

Content
`;
		const result = computeDocumentStats(content, 'doc.md', 100);

		expect(result.description).toBe('This is the overview');
	});

	it('should preserve the full file path', () => {
		const content = '# Test';
		const result = computeDocumentStats(content, 'deeply/nested/path/to/file.md', 100);

		expect(result.filePath).toBe('deeply/nested/path/to/file.md');
	});

	describe('malformed content handling (graceful degradation)', () => {
		describe('null/undefined/invalid input handling', () => {
			it('should handle null content without crashing', () => {
				// @ts-expect-error Testing runtime behavior with null input
				const result = computeDocumentStats(null, 'doc.md', 100);

				expect(result.title).toBe('doc');
				expect(result.lineCount).toBe(0);
				expect(result.wordCount).toBe(0);
				expect(result.size).toBe('100 B');
				expect(result.filePath).toBe('doc.md');
			});

			it('should handle undefined content without crashing', () => {
				// @ts-expect-error Testing runtime behavior with undefined input
				const result = computeDocumentStats(undefined, 'doc.md', 100);

				expect(result.title).toBe('doc');
				expect(result.lineCount).toBe(0);
				expect(result.wordCount).toBe(0);
			});

			it('should handle null filePath without crashing', () => {
				// @ts-expect-error Testing runtime behavior with null input
				const result = computeDocumentStats('# Test', null, 100);

				// Should use fallback path
				expect(result.filePath).toBe('unknown.md');
				expect(result.title).toBe('Test');
			});

			it('should handle undefined filePath without crashing', () => {
				// @ts-expect-error Testing runtime behavior with undefined input
				const result = computeDocumentStats('# Test', undefined, 100);

				expect(result.filePath).toBe('unknown.md');
			});

			it('should handle NaN fileSize without crashing', () => {
				const result = computeDocumentStats('# Test', 'doc.md', NaN);

				expect(result.size).toBe('0 B');
			});

			it('should handle undefined fileSize without crashing', () => {
				// @ts-expect-error Testing runtime behavior with undefined input
				const result = computeDocumentStats('# Test', 'doc.md', undefined);

				expect(result.size).toBe('0 B');
			});

			it('should handle negative fileSize without crashing', () => {
				const result = computeDocumentStats('# Test', 'doc.md', -500);

				expect(result.size).toBe('0 B');
			});

			it('should handle all null parameters without crashing', () => {
				// @ts-expect-error Testing runtime behavior with null inputs
				const result = computeDocumentStats(null, null, null);

				expect(result.filePath).toBe('unknown.md');
				expect(result.title).toBe('unknown');
				expect(result.lineCount).toBe(0);
				expect(result.wordCount).toBe(0);
				expect(result.size).toBe('0 B');
			});
		});

		describe('binary and special content', () => {
			it('should handle content with null bytes', () => {
				const content = '# Title\x00with\x00null\x00bytes';
				const result = computeDocumentStats(content, 'doc.md', 100);

				// Should not crash
				expect(result).toBeDefined();
				expect(result.title).toBeDefined();
			});

			it('should handle content with control characters', () => {
				const content = '# Title\x01\x02\x03\x04\x05 with control chars';
				const result = computeDocumentStats(content, 'doc.md', 100);

				expect(result.title).toBe('Title\x01\x02\x03\x04\x05 with control chars');
			});

			it('should handle content with only binary data', () => {
				const content = '\x00\x01\x02\x03\x04\x05\x06\x07';
				const result = computeDocumentStats(content, 'binary.md', 8);

				// Should not crash, should use filename as title
				expect(result.title).toBe('binary');
			});

			it('should handle very long content', () => {
				const content = 'x'.repeat(1024 * 1024); // 1MB
				const result = computeDocumentStats(content, 'large.md', 1024 * 1024);

				expect(result.title).toBe('large');
				expect(result.wordCount).toBe(1); // All one "word"
				expect(result.lineCount).toBe(1);
			});
		});

		describe('malformed front matter', () => {
			it('should handle corrupted front matter without crashing', () => {
				const content = `---
this: is: invalid: yaml
nested:
  without: proper
    indentation
---

# Title`;
				const result = computeDocumentStats(content, 'doc.md', 100);

				// Should not crash, title should fall back to heading or filename
				expect(result).toBeDefined();
				expect(result.title).toBeDefined();
			});

			it('should handle front matter with only opening delimiter', () => {
				const content = `---
title: Incomplete`;
				const result = computeDocumentStats(content, 'doc.md', 100);

				// Should not crash
				expect(result.title).toBe('doc');
			});
		});

		describe('edge cases in stats computation', () => {
			it('should handle content with only newlines', () => {
				const content = '\n\n\n\n\n';
				const result = computeDocumentStats(content, 'empty.md', 5);

				expect(result.lineCount).toBe(0);
				expect(result.wordCount).toBe(0);
			});

			it('should handle content with only whitespace', () => {
				const content = '     \t\t\t   \n   \t   ';
				const result = computeDocumentStats(content, 'whitespace.md', 20);

				expect(result.lineCount).toBe(0);
				expect(result.wordCount).toBe(0);
			});

			it('should handle mixed line endings', () => {
				const content = 'Line1\rLine2\r\nLine3\nLine4';
				const result = computeDocumentStats(content, 'doc.md', 100);

				// Just checking it doesn't crash - line count may vary based on implementation
				expect(result).toBeDefined();
			});

			it('should handle extremely long single line', () => {
				const content = 'word '.repeat(100000);
				const result = computeDocumentStats(content, 'doc.md', 500000);

				expect(result.lineCount).toBe(1);
				expect(result.wordCount).toBe(100000);
			});

			it('should handle content with Unicode characters', () => {
				const content = '# 日本語タイトル\n\n中文内容 和 한국어';
				const result = computeDocumentStats(content, 'unicode.md', 100);

				expect(result.title).toBe('日本語タイトル');
				expect(result.wordCount).toBeGreaterThan(0);
			});

			it('should handle content with emojis', () => {
				const content = '# 🎉 Celebration 🎊\n\n🚀 Rocket 🌟 Star';
				const result = computeDocumentStats(content, 'emoji.md', 100);

				expect(result.title).toBe('🎉 Celebration 🎊');
			});
		});
	});
});
