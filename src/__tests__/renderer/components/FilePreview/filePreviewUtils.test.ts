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
	isCodeFile,
	LARGE_FILE_TOKEN_SKIP_THRESHOLD,
	LARGE_FILE_PREVIEW_LIMIT,
	pickPreviewTier,
	countLines,
	scanLineStats,
	FAST_TIER_BYTES,
	FAST_TIER_LINES,
	GIANT_TIER_BYTES,
	GIANT_TIER_LINES,
	LINE_LENGTH_GIANT_THRESHOLD,
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
			expect(formatFileSize(1024)).toBe('1.0 KB');
			expect(formatFileSize(1536)).toBe('1.5 KB');
		});

		it('formats megabytes', () => {
			expect(formatFileSize(1048576)).toBe('1.0 MB');
		});

		it('formats gigabytes', () => {
			expect(formatFileSize(1073741824)).toBe('1.0 GB');
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

		it('does not close a longer fence with a shorter delimiter', () => {
			const content = '````markdown\n```\n- [ ] inside fence\n````\n- [ ] outside';
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

	describe('countLines', () => {
		it('returns 0 for empty input', () => {
			expect(countLines('')).toBe(0);
		});

		it('returns 1 for a single line with no trailing newline', () => {
			expect(countLines('hello')).toBe(1);
		});

		it('counts newlines plus one', () => {
			expect(countLines('a\nb\nc')).toBe(3);
		});

		it('counts the trailing newline as an extra empty line', () => {
			expect(countLines('a\n')).toBe(2);
		});
	});

	describe('scanLineStats', () => {
		it('returns zero counts for empty input', () => {
			expect(scanLineStats('')).toEqual({ lines: 0, maxLineLength: 0 });
		});

		it('reports a single line with no newline', () => {
			expect(scanLineStats('hello')).toEqual({ lines: 1, maxLineLength: 5 });
		});

		it('tracks the longest line across the document', () => {
			expect(scanLineStats('aa\nbbbb\ncc')).toEqual({ lines: 3, maxLineLength: 4 });
		});

		it('handles a single pathologically long line', () => {
			const huge = 'A'.repeat(500_000);
			expect(scanLineStats(huge)).toEqual({ lines: 1, maxLineLength: 500_000 });
		});

		it('handles many short lines with one long line at the end', () => {
			const content = 'a\n'.repeat(10) + 'A'.repeat(50_000);
			const stats = scanLineStats(content);
			expect(stats.lines).toBe(11);
			expect(stats.maxLineLength).toBe(50_000);
		});

		it('treats a trailing newline as the start of an empty line', () => {
			expect(scanLineStats('hello\n')).toEqual({ lines: 2, maxLineLength: 5 });
		});

		it('returns the same line count that countLines would', () => {
			const samples = ['', 'a', 'a\nb', 'a\n', 'a\n\nb\n'];
			for (const s of samples) {
				expect(scanLineStats(s).lines).toBe(countLines(s));
			}
		});
	});

	describe('pickPreviewTier', () => {
		it('returns rich for small files', () => {
			expect(pickPreviewTier(1024, 50)).toBe('rich');
			expect(pickPreviewTier(FAST_TIER_BYTES, FAST_TIER_LINES)).toBe('rich');
		});

		it('escalates to fast when bytes exceed FAST_TIER_BYTES', () => {
			expect(pickPreviewTier(FAST_TIER_BYTES + 1, 100)).toBe('fast');
		});

		it('escalates to fast when lines exceed FAST_TIER_LINES even if bytes are small', () => {
			expect(pickPreviewTier(1024, FAST_TIER_LINES + 1)).toBe('fast');
		});

		it('escalates to giant when bytes exceed GIANT_TIER_BYTES', () => {
			expect(pickPreviewTier(GIANT_TIER_BYTES + 1, 100)).toBe('giant');
		});

		it('escalates to giant when lines exceed GIANT_TIER_LINES', () => {
			expect(pickPreviewTier(1024, GIANT_TIER_LINES + 1)).toBe('giant');
		});

		it('keeps the user-reported 300k-line markdown case in Fast (rendered) tier', () => {
			// 300k lines × ~20 bytes ≈ 6MB - under the 8MB / 500k-line giant
			// threshold so rendered markdown still wins. Truly enormous files
			// (>8MB or >500k lines) fall through to Giant for source view.
			expect(pickPreviewTier(6 * 1024 * 1024, 300_000)).toBe('fast');
		});

		it('routes truly enormous files to Giant', () => {
			expect(pickPreviewTier(20 * 1024 * 1024, 1_000_000)).toBe('giant');
		});

		describe('pathologically long lines', () => {
			it('escalates to Giant when maxLineLength exceeds the threshold', () => {
				// File would otherwise be Rich (small bytes, few lines) but a
				// single huge line freezes Fast tier's pre-rendered DOM.
				expect(pickPreviewTier(500_000, 1, LINE_LENGTH_GIANT_THRESHOLD + 1)).toBe('giant');
			});

			it('does not escalate when maxLineLength equals the threshold (boundary is exclusive)', () => {
				// File is 500 KB (over Rich's 256 KB threshold) → Fast tier.
				// Long-line escalation is strictly `>` threshold so equality
				// does not push it to Giant.
				expect(pickPreviewTier(500_000, 1, LINE_LENGTH_GIANT_THRESHOLD)).toBe('fast');
			});

			it('defaults maxLineLength to 0 when omitted (back-compat)', () => {
				expect(pickPreviewTier(1024, 50)).toBe('rich');
			});

			it('long-line signal does not downgrade tiers (Giant stays Giant)', () => {
				expect(pickPreviewTier(20 * 1024 * 1024, 1_000_000, 5_000)).toBe('giant');
			});

			it('does not escalate markdown to Giant on a long line (renders instead of showing source)', () => {
				// A small markdown note with one pathologically long prose line
				// (e.g. a pasted transcript) stays renderable: markdown wraps in
				// HTML, so the long-line jump is skipped and it lands in Rich.
				expect(pickPreviewTier(1024, 50, LINE_LENGTH_GIANT_THRESHOLD + 1, true)).toBe('rich');
			});

			it('still honors byte/line Giant thresholds for markdown', () => {
				// The carve-out only drops the long-line signal; genuinely huge
				// markdown (over 8MB / 500k lines) still falls through to Giant.
				expect(pickPreviewTier(GIANT_TIER_BYTES + 1, 100, 5_000, true)).toBe('giant');
			});

			it('markdown with a long line over Fast byte threshold lands in Fast (still rendered)', () => {
				// Over 256 KB but under Giant byte/line limits: markdown skips the
				// long-line escalation and renders via Fast tier, not Giant source.
				expect(pickPreviewTier(500_000, 1, LINE_LENGTH_GIANT_THRESHOLD + 1, true)).toBe('fast');
			});
		});
	});

	describe('preview tier threshold values', () => {
		it('FAST_TIER_BYTES is 256KB', () => {
			expect(FAST_TIER_BYTES).toBe(256 * 1024);
		});

		it('FAST_TIER_LINES is 5,000', () => {
			expect(FAST_TIER_LINES).toBe(5_000);
		});

		it('GIANT_TIER_BYTES is 8MB', () => {
			expect(GIANT_TIER_BYTES).toBe(8 * 1024 * 1024);
		});

		it('GIANT_TIER_LINES is 500,000', () => {
			expect(GIANT_TIER_LINES).toBe(500_000);
		});

		it('fast threshold is below giant threshold', () => {
			expect(FAST_TIER_BYTES).toBeLessThan(GIANT_TIER_BYTES);
			expect(FAST_TIER_LINES).toBeLessThan(GIANT_TIER_LINES);
		});
	});

	describe('isCodeFile', () => {
		it('returns true for source-code languages', () => {
			for (const lang of ['typescript', 'tsx', 'python', 'rust', 'go', 'json', 'yaml']) {
				expect(isCodeFile(lang)).toBe(true);
			}
		});

		it('returns false for plain text', () => {
			expect(isCodeFile('text')).toBe(false);
		});

		it('returns false for markdown (handled by its own Fast tier)', () => {
			expect(isCodeFile('markdown')).toBe(false);
		});

		it('returns true for any other non-empty language identifier', () => {
			expect(isCodeFile('whatever')).toBe(true);
		});
	});
});
