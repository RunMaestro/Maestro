import { describe, it, expect } from 'vitest';
import {
	getLanguageFromFilename,
	isBinaryContent,
	isBinaryExtension,
	formatFileSize,
	formatDateTime,
	countMarkdownTasks,
	extractHeadings,
	resolveImagePath,
	LARGE_FILE_TOKEN_SKIP_THRESHOLD,
	LARGE_FILE_PREVIEW_LIMIT,
} from '../../../../renderer/components/FilePreview/filePreviewUtils';

describe('filePreviewUtils', () => {
	describe('getLanguageFromFilename', () => {
		it('returns typescript for .ts files', () => {
			expect(getLanguageFromFilename('index.ts')).toBe('typescript');
		});

		it('returns tsx for .tsx files', () => {
			expect(getLanguageFromFilename('App.tsx')).toBe('tsx');
		});

		it('returns javascript for .js files', () => {
			expect(getLanguageFromFilename('main.js')).toBe('javascript');
		});

		it('returns markdown for .md files', () => {
			expect(getLanguageFromFilename('README.md')).toBe('markdown');
		});

		it('returns python for .py files', () => {
			expect(getLanguageFromFilename('script.py')).toBe('python');
		});

		it('returns yaml for .yml files', () => {
			expect(getLanguageFromFilename('config.yml')).toBe('yaml');
		});

		it('returns csv for .csv files', () => {
			expect(getLanguageFromFilename('data.csv')).toBe('csv');
		});

		it('returns jsonl for .jsonl files', () => {
			expect(getLanguageFromFilename('data.jsonl')).toBe('jsonl');
		});

		it('returns jsonl for .ndjson files', () => {
			expect(getLanguageFromFilename('stream.ndjson')).toBe('jsonl');
		});

		it('returns text for unknown extensions', () => {
			expect(getLanguageFromFilename('file.xyz')).toBe('text');
		});

		it('returns text for files with no extension', () => {
			expect(getLanguageFromFilename('Makefile')).toBe('text');
		});
	});

	describe('isBinaryContent', () => {
		it('detects null bytes as binary', () => {
			expect(isBinaryContent('hello\0world')).toBe(true);
		});

		it('returns false for normal text', () => {
			expect(isBinaryContent('Hello, world!\nThis is text.')).toBe(false);
		});

		it('returns false for empty content', () => {
			expect(isBinaryContent('')).toBe(false);
		});

		it('allows common whitespace (tab, newline, carriage return)', () => {
			expect(isBinaryContent('hello\tworld\r\n')).toBe(false);
		});

		it('detects high non-printable ratio as binary', () => {
			// Create content with >10% non-printable characters
			const binary = String.fromCharCode(1).repeat(20) + 'a'.repeat(80);
			expect(isBinaryContent(binary)).toBe(true);
		});

		it('allows low non-printable ratio as text', () => {
			// Less than 10% non-printable
			const almostText = String.fromCharCode(1).repeat(5) + 'a'.repeat(100);
			expect(isBinaryContent(almostText)).toBe(false);
		});
	});

	describe('isBinaryExtension', () => {
		it('returns true for image-related extensions', () => {
			expect(isBinaryExtension('icon.icns')).toBe(true);
			expect(isBinaryExtension('assets.car')).toBe(true);
		});

		it('returns true for compiled files', () => {
			expect(isBinaryExtension('module.o')).toBe(true);
			expect(isBinaryExtension('lib.so')).toBe(true);
			expect(isBinaryExtension('Main.class')).toBe(true);
			expect(isBinaryExtension('module.wasm')).toBe(true);
		});

		it('returns true for archives', () => {
			expect(isBinaryExtension('archive.zip')).toBe(true);
			expect(isBinaryExtension('backup.tar')).toBe(true);
			expect(isBinaryExtension('data.gz')).toBe(true);
		});

		it('returns true for fonts', () => {
			expect(isBinaryExtension('font.ttf')).toBe(true);
			expect(isBinaryExtension('font.woff2')).toBe(true);
		});

		it('returns false for text files', () => {
			expect(isBinaryExtension('index.ts')).toBe(false);
			expect(isBinaryExtension('README.md')).toBe(false);
			expect(isBinaryExtension('styles.css')).toBe(false);
		});

		it('returns false for files with no extension', () => {
			expect(isBinaryExtension('Makefile')).toBe(false);
		});

		it('is case-insensitive', () => {
			expect(isBinaryExtension('file.ZIP')).toBe(true);
		});
	});

	describe('formatFileSize', () => {
		it('formats 0 bytes', () => {
			expect(formatFileSize(0)).toBe('0 B');
		});

		it('formats bytes', () => {
			expect(formatFileSize(512)).toBe('512 B');
		});

		it('formats kilobytes', () => {
			expect(formatFileSize(1024)).toBe('1 KB');
			expect(formatFileSize(1536)).toBe('1.5 KB');
		});

		it('formats megabytes', () => {
			expect(formatFileSize(1048576)).toBe('1 MB');
		});

		it('formats gigabytes', () => {
			expect(formatFileSize(1073741824)).toBe('1 GB');
		});
	});

	describe('formatDateTime', () => {
		it('formats an ISO date string', () => {
			const result = formatDateTime('2024-01-15T10:30:00Z');
			expect(result).toBeTruthy();
			expect(typeof result).toBe('string');
			// The exact format depends on locale, but it should contain the year
			expect(result).toContain('2024');
		});
	});

	describe('countMarkdownTasks', () => {
		it('counts open and closed tasks', () => {
			const content = `
- [ ] Todo 1
- [x] Done 1
- [ ] Todo 2
- [X] Done 2
			`;
			const result = countMarkdownTasks(content);
			expect(result.open).toBe(2);
			expect(result.closed).toBe(2);
		});

		it('returns 0 for no tasks', () => {
			const result = countMarkdownTasks('Just plain text');
			expect(result.open).toBe(0);
			expect(result.closed).toBe(0);
		});

		it('handles asterisk-style tasks', () => {
			const content = '* [ ] open\n* [x] closed';
			const result = countMarkdownTasks(content);
			expect(result.open).toBe(1);
			expect(result.closed).toBe(1);
		});

		it('handles indented tasks', () => {
			const content = '  - [ ] indented open\n  - [x] indented closed';
			const result = countMarkdownTasks(content);
			expect(result.open).toBe(1);
			expect(result.closed).toBe(1);
		});

		it('ignores tasks inside backtick code fences', () => {
			const content = '- [ ] real\n```\n- [ ] fake\n- [x] also fake\n```\n- [x] also real';
			const result = countMarkdownTasks(content);
			expect(result.open).toBe(1);
			expect(result.closed).toBe(1);
		});

		it('ignores tasks inside tilde code fences', () => {
			const content = '~~~\n- [ ] inside fence\n~~~\n- [ ] outside';
			const result = countMarkdownTasks(content);
			expect(result.open).toBe(1);
			expect(result.closed).toBe(0);
		});
	});

	describe('extractHeadings', () => {
		it('extracts ATX-style headings', () => {
			const content = '# H1\n## H2\n### H3';
			const result = extractHeadings(content);
			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({ level: 1, text: 'H1', slug: 'h1' });
			expect(result[1]).toEqual({ level: 2, text: 'H2', slug: 'h2' });
			expect(result[2]).toEqual({ level: 3, text: 'H3', slug: 'h3' });
		});

		it('ignores headings inside code fences', () => {
			const content = '# Real\n```\n# Not a heading\n```\n## Also real';
			const result = extractHeadings(content);
			expect(result).toHaveLength(2);
			expect(result[0].text).toBe('Real');
			expect(result[1].text).toBe('Also real');
		});

		it('handles tilde code fences', () => {
			const content = '# Before\n~~~\n# Inside\n~~~\n# After';
			const result = extractHeadings(content);
			expect(result).toHaveLength(2);
		});

		it('returns empty array for no headings', () => {
			expect(extractHeadings('Just text')).toHaveLength(0);
		});

		it('generates unique slugs for duplicate headings', () => {
			const content = '# Title\n# Title\n# Title';
			const result = extractHeadings(content);
			expect(result).toHaveLength(3);
			expect(result[0].slug).toBe('title');
			expect(result[1].slug).toBe('title-1');
			expect(result[2].slug).toBe('title-2');
		});
	});

	describe('resolveImagePath', () => {
		it('returns data URLs as-is', () => {
			expect(resolveImagePath('data:image/png;base64,abc', '/docs/readme.md')).toBe(
				'data:image/png;base64,abc'
			);
		});

		it('returns http URLs as-is', () => {
			expect(resolveImagePath('https://example.com/img.png', '/docs/readme.md')).toBe(
				'https://example.com/img.png'
			);
		});

		it('returns absolute paths as-is', () => {
			expect(resolveImagePath('/absolute/path.png', '/docs/readme.md')).toBe('/absolute/path.png');
		});

		it('resolves relative paths from markdown directory', () => {
			expect(resolveImagePath('images/photo.png', '/project/docs/readme.md')).toBe(
				'/project/docs/images/photo.png'
			);
		});

		it('handles ./ prefix', () => {
			expect(resolveImagePath('./images/photo.png', '/project/docs/readme.md')).toBe(
				'/project/docs/images/photo.png'
			);
		});

		it('resolves ../ paths by normalization', () => {
			expect(resolveImagePath('../assets/img.png', '/project/docs/readme.md')).toBe(
				'/project/assets/img.png'
			);
		});

		it('resolves deeply nested ../ paths', () => {
			expect(resolveImagePath('../../img.png', '/a/b/c/readme.md')).toBe('/a/img.png');
		});
	});

	describe('constants', () => {
		it('LARGE_FILE_TOKEN_SKIP_THRESHOLD is 1MB', () => {
			expect(LARGE_FILE_TOKEN_SKIP_THRESHOLD).toBe(1024 * 1024);
		});

		it('LARGE_FILE_PREVIEW_LIMIT is 100KB', () => {
			expect(LARGE_FILE_PREVIEW_LIMIT).toBe(100 * 1024);
		});
	});
});
