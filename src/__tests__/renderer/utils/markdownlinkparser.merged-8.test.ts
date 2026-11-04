// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/markdownLinkParser.test.ts
// Source: src/__tests__/renderer/utils/mediaFloatGeometry.test.ts
// Source: src/__tests__/renderer/utils/openUiSurface.test.ts
// Source: src/__tests__/renderer/utils/quoteSelection.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
/**
 * Comprehensive tests for markdown link parser utility.
 *
 * Tests cover:
 * - extractDomain: URL domain extraction with www stripping and fallback
 * - parseMarkdownLinks: wiki links, markdown links, front matter, deduplication
 * - Internal path utilities (dirname, extname, joinPath, resolveRelativePath)
 *   tested indirectly via parseMarkdownLinks
 * - Edge cases: malformed input, URL encoding, special characters
 */
import {
	parseMarkdownLinks,
	extractDomain,
	type ParsedMarkdownLinks,
	type ParseMarkdownLinksOptions,
} from '../../../renderer/utils/markdownLinkParser';
import {
	DEFAULT_MEDIA_ASPECT,
	MEDIA_FLOAT_DEFAULT_WIDTH,
	MEDIA_FLOAT_EDGE_MARGIN,
	MEDIA_FLOAT_MIN_WIDTH,
	MEDIA_FLOAT_TITLE_BAR_HEIGHT,
	MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT,
	fitMediaFloatRect,
	initialMediaFloatRect,
	mediaFloatChromeHeight,
	mediaFloatHeight,
	mediaFloatResizeWidth,
	mediaFloatWidthFor,
	normalizeMediaAspect,
	sanitizeMediaFloat,
	MEDIA_FLOAT_LANE_LIFT_RATIO,
	mediaFloatFootprint,
	mediaFloatLaneLift,
	type MediaFloatBottomLane,
	type MediaFloatFit,
} from '../../../renderer/utils/mediaFloatGeometry';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import { selectModalOpen, useModalStore } from '../../../renderer/stores/modalStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../renderer/stores/throughputGaugeStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { appendQuoteToDraft, formatMarkdownQuote } from '../../../renderer/utils/quoteSelection';
// Source: src/__tests__/renderer/utils/markdownLinkParser.test.ts
describe('', () => {
	// ---------------------------------------------------------------------------
	// extractDomain
	// ---------------------------------------------------------------------------
	describe('extractDomain', () => {
		it('should extract domain from simple HTTPS URL', () => {
			expect(extractDomain('https://example.com')).toBe('example.com');
		});
		it('should extract domain from HTTPS URL with path', () => {
			expect(extractDomain('https://github.com/user/repo')).toBe('github.com');
		});
		it('should extract domain from HTTP URL', () => {
			expect(extractDomain('http://example.com/page')).toBe('example.com');
		});
		it('should strip www. prefix', () => {
			expect(extractDomain('https://www.github.com/user/repo')).toBe('github.com');
		});
		it('should extract domain from URL with path segments', () => {
			expect(extractDomain('https://example.com/path/to/page')).toBe('example.com');
		});
		it('should handle URLs with port numbers', () => {
			expect(extractDomain('https://example.com:8080')).toBe('example.com');
		});
		it('should handle localhost with port', () => {
			expect(extractDomain('https://localhost:3000/path')).toBe('localhost');
		});
		it('should handle URLs with query parameters', () => {
			expect(extractDomain('https://example.com/path?query=value')).toBe('example.com');
		});
		it('should handle subdomain URLs', () => {
			expect(extractDomain('https://docs.github.com/en/pages')).toBe('docs.github.com');
		});
		it('should fall back to regex for invalid URLs', () => {
			// 'not-a-url' has no protocol, so URL constructor fails and regex also won't match
			expect(extractDomain('not-a-url')).toBe('not-a-url');
		});
		it('should fall back to regex extraction for malformed URLs with protocol', () => {
			// This URL has a protocol prefix so the regex fallback can extract the domain
			expect(extractDomain('http://some-domain.com')).toBe('some-domain.com');
		});
		it('should handle IDN domains (punycode)', () => {
			expect(extractDomain('https://\u4F8B\u3048.jp/path')).toBe('xn--r8jz45g.jp');
		});
		it('should strip www prefix from complex URLs', () => {
			expect(extractDomain('https://www.docs.example.com/path')).toBe('docs.example.com');
		});
		it('should handle URLs with trailing slashes', () => {
			expect(extractDomain('https://example.com/')).toBe('example.com');
		});
		it('should handle URLs with deep paths', () => {
			expect(extractDomain('https://github.com/org/repo/blob/main/src/file.ts')).toBe('github.com');
		});
		it('should return original for malformed URLs without match', () => {
			expect(extractDomain('http://incomplete')).toBe('incomplete');
		});
		it('should handle URLs with unusual TLDs', () => {
			expect(extractDomain('https://site.museum/collection')).toBe('site.museum');
			expect(extractDomain('https://company.technology/product')).toBe('company.technology');
		});
	});
	// ---------------------------------------------------------------------------
	// parseMarkdownLinks
	// ---------------------------------------------------------------------------
	describe('parseMarkdownLinks', () => {
		// -----------------------------------------------------------------------
		// Null / undefined / non-string content
		// -----------------------------------------------------------------------
		describe('null/undefined/non-string content', () => {
			it('should return empty result for null content', () => {
				// @ts-expect-error Testing runtime behavior with null input
				const result = parseMarkdownLinks(null, 'doc.md');
				expect(result.internalLinks).toEqual([]);
				expect(result.externalLinks).toEqual([]);
				expect(result.frontMatter).toEqual({});
			});
			it('should return empty result for undefined content', () => {
				// @ts-expect-error Testing runtime behavior with undefined input
				const result = parseMarkdownLinks(undefined, 'doc.md');
				expect(result.internalLinks).toEqual([]);
				expect(result.externalLinks).toEqual([]);
				expect(result.frontMatter).toEqual({});
			});
			it('should return empty result for non-string content types', () => {
				// @ts-expect-error Testing runtime behavior with number input
				const resultNumber = parseMarkdownLinks(12345, 'doc.md');
				expect(resultNumber.internalLinks).toEqual([]);
				expect(resultNumber.frontMatter).toEqual({});
				// @ts-expect-error Testing runtime behavior with object input
				const resultObject = parseMarkdownLinks({ text: 'content' }, 'doc.md');
				expect(resultObject.internalLinks).toEqual([]);
				expect(resultObject.frontMatter).toEqual({});
				// @ts-expect-error Testing runtime behavior with array input
				const resultArray = parseMarkdownLinks(['content'], 'doc.md');
				expect(resultArray.internalLinks).toEqual([]);
				expect(resultArray.frontMatter).toEqual({});
			});
			it('should handle empty filePath gracefully', () => {
				const content = 'See [[other-doc]] for more info.';
				const result = parseMarkdownLinks(content, '');
				expect(result.internalLinks).toContain('other-doc.md');
			});
		});
		// -----------------------------------------------------------------------
		// Wiki-style links
		// -----------------------------------------------------------------------
		describe('wiki-style links', () => {
			it('should parse simple wiki links [[Note]]', () => {
				const content = 'See [[other-doc]] for more info.';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				expect(result.internalLinks).toContain('docs/other-doc.md');
				expect(result.externalLinks).toHaveLength(0);
			});
			it('should parse wiki links with path [[Folder/Note]]', () => {
				const content = 'See [[subdir/nested-doc]] for details.';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				expect(result.internalLinks).toContain('docs/subdir/nested-doc.md');
			});
			it('should parse wiki links with display text [[Note|Display]]', () => {
				const content = 'Check out [[getting-started|the guide]].';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				expect(result.internalLinks).toContain('docs/getting-started.md');
			});
			it('should skip image wiki links (.png, .jpg, etc.)', () => {
				const content = '![[screenshot.png]] and [[image.jpg]] and [[photo.gif]] and [[doc-link]]';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				expect(result.internalLinks).toContain('docs/doc-link.md');
				expect(result.internalLinks).toHaveLength(1);
			});
			it('should skip various image extensions in wiki links', () => {
				const content = '[[a.jpeg]] [[b.webp]] [[c.svg]] [[d.bmp]] [[e.ico]] [[real-doc]]';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(1);
				expect(result.internalLinks).toContain('real-doc.md');
			});
			it('should handle multiple wiki links', () => {
				const content = 'Link to [[first]] and [[second]] and [[third]].';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(3);
				expect(result.internalLinks).toContain('first.md');
				expect(result.internalLinks).toContain('second.md');
				expect(result.internalLinks).toContain('third.md');
			});
		});
		// -----------------------------------------------------------------------
		// Standard markdown links
		// -----------------------------------------------------------------------
		describe('standard markdown links', () => {
			it('should parse external markdown links [text](https://example.com)', () => {
				const content = 'Visit [Example](https://example.com).';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.externalLinks).toHaveLength(1);
				expect(result.externalLinks[0].url).toBe('https://example.com');
				expect(result.externalLinks[0].domain).toBe('example.com');
			});
			it('should parse internal markdown links [text](./other.md)', () => {
				const content = 'See the [documentation](./docs/guide.md).';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('docs/guide.md');
			});
			it('should parse relative parent paths [text](../path.md)', () => {
				const content = 'See [parent doc](../other.md).';
				const result = parseMarkdownLinks(content, 'docs/guide.md');
				expect(result.internalLinks).toContain('other.md');
			});
			it('should extract external links with domains', () => {
				const content = 'Visit [GitHub](https://github.com).';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.externalLinks).toHaveLength(1);
				expect(result.externalLinks[0].url).toBe('https://github.com');
				expect(result.externalLinks[0].domain).toBe('github.com');
			});
			it('should handle multiple external links', () => {
				const content = `
Check [GitHub](https://github.com) and [Google](https://www.google.com).
Also see [Docs](https://docs.example.com/page).
      `;
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.externalLinks).toHaveLength(3);
				expect(result.externalLinks.map((l) => l.domain)).toContain('github.com');
				expect(result.externalLinks.map((l) => l.domain)).toContain('google.com');
				expect(result.externalLinks.map((l) => l.domain)).toContain('docs.example.com');
			});
			it('should skip anchor links (#section)', () => {
				const content = 'See [section](#heading) for details.';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(0);
				expect(result.externalLinks).toHaveLength(0);
			});
			it('should skip mailto links', () => {
				const content = 'Contact [support](mailto:help@example.com).';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(0);
				expect(result.externalLinks).toHaveLength(0);
			});
			it('should add .md extension when missing for internal links', () => {
				const content = '[doc](./other-file)';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('other-file.md');
			});
		});
		// -----------------------------------------------------------------------
		// Relative path resolution (tests path utilities indirectly)
		// -----------------------------------------------------------------------
		describe('relative path resolution', () => {
			it('should resolve ./sibling.md correctly', () => {
				const content = '[sibling](./sibling.md)';
				const result = parseMarkdownLinks(content, 'docs/current.md');
				expect(result.internalLinks).toContain('docs/sibling.md');
			});
			it('should resolve ../parent.md correctly', () => {
				const content = '[parent](../parent.md)';
				const result = parseMarkdownLinks(content, 'docs/nested/current.md');
				expect(result.internalLinks).toContain('docs/parent.md');
			});
			it('should resolve ../../grandparent.md from deeply nested paths', () => {
				const content = '[grandparent](../../grandparent.md)';
				const result = parseMarkdownLinks(content, 'a/b/c/current.md');
				expect(result.internalLinks).toContain('a/grandparent.md');
			});
			it('should resolve ../docs/file.md from nested/file.md', () => {
				const content = '[doc](../docs/file.md)';
				const result = parseMarkdownLinks(content, 'nested/file.md');
				expect(result.internalLinks).toContain('docs/file.md');
			});
			it('should handle paths without leading ./', () => {
				const content = '[[sibling-note]]';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				expect(result.internalLinks).toContain('docs/sibling-note.md');
			});
			it('should normalize backslashes in paths', () => {
				// Wiki links with backslash separators
				const content = '[[folder\\subfolder\\note]]';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				// The internal joinPath normalizes backslashes to forward slashes
				expect(result.internalLinks).toHaveLength(1);
				expect(result.internalLinks[0]).not.toContain('\\');
			});
			it('should handle absolute-like paths starting with /', () => {
				const content = '[root](/root-doc.md)';
				const result = parseMarkdownLinks(content, 'docs/current.md');
				// /root-doc.md starts with / which is not http/https and not # or mailto
				// joinPath('docs', '/root-doc.md') will produce something
				expect(result.internalLinks).toHaveLength(1);
			});
			it('should handle files at root level (no directory)', () => {
				const content = '[[sibling]]';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('sibling.md');
			});
			it('should preserve .md extension if already present', () => {
				const content = '[[already.md]]';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('already.md');
			});
		});
		// -----------------------------------------------------------------------
		// Deduplication
		// -----------------------------------------------------------------------
		describe('deduplication', () => {
			it('should deduplicate internal links', () => {
				const content = 'See [[doc]] and [[doc]] again.';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(1);
			});
			it('should deduplicate external links', () => {
				const content = `
[GitHub](https://github.com) and [GitHub again](https://github.com).
      `;
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.externalLinks).toHaveLength(1);
			});
			it('should not deduplicate different paths to same filename', () => {
				const content = '[[docs/readme]] and [[other/readme]]';
				const result = parseMarkdownLinks(content, 'index.md');
				expect(result.internalLinks).toHaveLength(2);
			});
			it('should deduplicate wiki link and markdown link to same target', () => {
				const content = '[[other-doc]] and [link](./other-doc.md)';
				const result = parseMarkdownLinks(content, 'readme.md');
				// Both resolve to 'other-doc.md' from root
				expect(result.internalLinks).toHaveLength(1);
				expect(result.internalLinks).toContain('other-doc.md');
			});
		});
		// -----------------------------------------------------------------------
		// Front matter parsing
		// -----------------------------------------------------------------------
		describe('front matter parsing', () => {
			it('should parse key: value pairs', () => {
				const content = `---
title: My Document
description: A test document
version: 1.0
---

# Content here
`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.title).toBe('My Document');
				expect(result.frontMatter.description).toBe('A test document');
				expect(result.frontMatter.version).toBe(1.0);
			});
			it('should handle double-quoted values', () => {
				const content = `---
title: "Quoted Title"
---

Content
`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.title).toBe('Quoted Title');
			});
			it('should handle single-quoted values', () => {
				const content = `---
subtitle: 'Single quoted'
---

Content
`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.subtitle).toBe('Single quoted');
			});
			it('should parse boolean values (true/false)', () => {
				const content = `---
draft: true
published: false
---

Content
`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.draft).toBe(true);
				expect(result.frontMatter.published).toBe(false);
			});
			it('should parse numeric values', () => {
				const content = `---
version: 42
pi: 3.14
negative: -7
---

Content
`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.version).toBe(42);
				expect(result.frontMatter.pi).toBe(3.14);
				expect(result.frontMatter.negative).toBe(-7);
			});
			it('should skip comments (#)', () => {
				const content = `---
title: My Doc
# This is a comment
author: John
---

Content
`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.title).toBe('My Doc');
				expect(result.frontMatter.author).toBe('John');
				expect(Object.keys(result.frontMatter)).toHaveLength(2);
			});
			it('should return empty object when no front matter', () => {
				const content = '# Just a heading\n\nSome content.';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter).toEqual({});
			});
			it('should return empty object for missing front matter', () => {
				const content = 'No front matter at all, just plain text.';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter).toEqual({});
			});
			it('should handle front matter with only opening delimiter', () => {
				const content = `---
title: No closing delimiter
Some content here.`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter).toEqual({});
			});
			it('should handle front matter with invalid YAML-like content', () => {
				const content = `---
this is not valid yaml at all
: colon at start
no colon here
   indented : weirdly
---

# Heading`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result).toBeDefined();
				expect(result.frontMatter).toBeDefined();
			});
			it('should handle content that is only delimiters', () => {
				const content = '---\n---';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter).toEqual({});
			});
			it('should handle very long front matter values', () => {
				const longValue = 'x'.repeat(100000);
				const content = `---
title: ${longValue}
---

Content`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.frontMatter.title).toBe(longValue);
			});
			it('should handle front matter with binary-like content', () => {
				const content = `---
title: \x00\x01\x02\x03
binary: \xff\xfe
---

Content`;
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result).toBeDefined();
			});
		});
		// -----------------------------------------------------------------------
		// Mixed internal and external links
		// -----------------------------------------------------------------------
		describe('mixed content', () => {
			it('should parse both internal and external links together', () => {
				const content = `---
title: Mixed Doc
---

See [[internal-doc]] for local info.
Check [GitHub](https://github.com) for code.
Also see [another doc](./other.md) here.
      `;
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(2);
				expect(result.externalLinks).toHaveLength(1);
				expect(result.frontMatter.title).toBe('Mixed Doc');
			});
			it('should correctly classify wiki links as internal and http links as external', () => {
				const content = `
[[wiki-link]]
[ext](https://external.com)
[int](./internal.md)
[http-link](http://another.com/page)
[[another-wiki]]
`;
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				expect(result.internalLinks).toHaveLength(3); // wiki-link, internal.md, another-wiki
				expect(result.externalLinks).toHaveLength(2); // external.com, another.com
			});
		});
		// -----------------------------------------------------------------------
		// URL-encoded paths
		// -----------------------------------------------------------------------
		describe('URL-encoded paths', () => {
			it('should handle URL-encoded paths (%20 for spaces)', () => {
				const content = '[doc](./my%20document.md)';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('my document.md');
			});
			it('should handle malformed URL encoding gracefully', () => {
				const content = '[doc](./my%ZZdocument.md)';
				const result = parseMarkdownLinks(content, 'readme.md');
				// Should use original path when decoding fails
				expect(result.internalLinks).toContain('my%ZZdocument.md');
			});
			it('should handle incomplete percent encoding', () => {
				const content = '[doc](./document%.md)';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(1);
				expect(result.internalLinks[0]).toContain('document');
			});
			it('should handle multiple invalid percent sequences', () => {
				const content = '[doc](./my%ZZ%YYdocument%XXtest.md)';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toHaveLength(1);
			});
		});
		// -----------------------------------------------------------------------
		// Edge cases
		// -----------------------------------------------------------------------
		describe('edge cases', () => {
			it('should handle empty content', () => {
				const result = parseMarkdownLinks('', 'doc.md');
				expect(result.internalLinks).toHaveLength(0);
				expect(result.externalLinks).toHaveLength(0);
				expect(result.frontMatter).toEqual({});
			});
			it('should handle content with null bytes', () => {
				const content = 'Some text\x00with null\x00bytes [[link]].';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result).toBeDefined();
			});
			it('should handle content with control characters', () => {
				const content = 'Text\x01\x02\x03\x04\x05 with [[link]] control chars.';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.internalLinks).toContain('link.md');
			});
			it('should handle content with mixed line endings', () => {
				const content = 'Line1\rLine2\r\nLine3\nLine4\r\n[[link]]';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.internalLinks).toContain('link.md');
			});
			it('should handle extremely long content without hanging', () => {
				const longContent = 'x'.repeat(1024 * 1024) + '[[link]]';
				const result = parseMarkdownLinks(longContent, 'doc.md');
				expect(result.internalLinks).toContain('link.md');
			});
			it('should handle content starting and ending with brackets', () => {
				const content = '[[start]] content [[end]]';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.internalLinks).toContain('start.md');
				expect(result.internalLinks).toContain('end.md');
			});
		});
		// -----------------------------------------------------------------------
		// Malformed wiki links
		// -----------------------------------------------------------------------
		describe('malformed wiki links', () => {
			it('should handle empty wiki links [[]]', () => {
				const content = 'See [[]] and [[valid-link]].';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.internalLinks).toContain('valid-link.md');
			});
			it('should handle wiki links with only whitespace [[ ]]', () => {
				const content = 'See [[   ]] and [[valid-link]].';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.internalLinks).toContain('valid-link.md');
			});
			it('should handle unclosed wiki links', () => {
				const content = 'See [[unclosed and [[closed]].';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result).toBeDefined();
			});
			it('should handle nested brackets in wiki links', () => {
				const content = 'See [[link[with]brackets]].';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result).toBeDefined();
			});
			it('should handle wiki links with special characters', () => {
				const content =
					'See [[link-with-\u00E9mojis-\uD83C\uDF89]] and [[\u65E5\u672C\u8A9E\u30EA\u30F3\u30AF]].';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result.internalLinks).toHaveLength(2);
			});
			it('should handle deeply nested bracket patterns', () => {
				const content = '[[[[[[nested]]]]]]';
				const result = parseMarkdownLinks(content, 'doc.md');
				expect(result).toBeDefined();
			});
			it('should handle interleaved wiki and markdown links', () => {
				const content = '[[wiki-[nested](./md.md)-link]] and [md-[[wiki]]-link](./file.md)';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result).toBeDefined();
			});
		});
		// -----------------------------------------------------------------------
		// Malformed markdown links
		// -----------------------------------------------------------------------
		describe('malformed markdown links', () => {
			it('should handle empty markdown links []()', () => {
				const content = 'See []() and [text](./valid.md).';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('valid.md');
			});
			it('should handle markdown links with no URL [text]()', () => {
				const content = 'See [text with no url]() here.';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result).toBeDefined();
			});
			it('should handle unclosed markdown links', () => {
				const content = 'See [unclosed link(./file.md and [closed](./valid.md).';
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result.internalLinks).toContain('valid.md');
			});
			it('should handle markdown links with newlines inside', () => {
				const content = `See [text
with newline](./file.md).`;
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result).toBeDefined();
			});
			it('should handle very long link URLs', () => {
				const longPath = 'a'.repeat(10000) + '.md';
				const content = `See [link](./${longPath}).`;
				const result = parseMarkdownLinks(content, 'readme.md');
				expect(result).toBeDefined();
			});
		});
		// -----------------------------------------------------------------------
		// External URLs with special characters
		// -----------------------------------------------------------------------
		describe('external URLs with special characters', () => {
			describe('URLs with parentheses', () => {
				it('should handle URLs with balanced parentheses (Wikipedia-style)', () => {
					const content = '[Wikipedia](https://en.wikipedia.org/wiki/Markdown_(example))';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe(
						'https://en.wikipedia.org/wiki/Markdown_(example)'
					);
					expect(result.externalLinks[0].domain).toBe('en.wikipedia.org');
				});
				it('should handle URLs with multiple parentheses pairs', () => {
					const content = '[Link](https://example.com/path/(a)/(b)/file)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe('https://example.com/path/(a)/(b)/file');
				});
				it('should handle URLs with parentheses at the end', () => {
					const content = '[Reference](https://example.com/wiki/Term_(disambiguation))';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe(
						'https://example.com/wiki/Term_(disambiguation)'
					);
				});
				it('should handle multiple URLs with parentheses in same content', () => {
					const content = `
See [First](https://en.wikipedia.org/wiki/A_(letter)) and
[Second](https://en.wikipedia.org/wiki/B_(letter)).
        `;
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(2);
					expect(result.externalLinks[0].url).toContain('A_(letter)');
					expect(result.externalLinks[1].url).toContain('B_(letter)');
				});
			});
			describe('URLs with query parameters', () => {
				it('should handle URLs with query parameters', () => {
					const content = '[Search](https://example.com/search?q=test&page=1&sort=date)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe(
						'https://example.com/search?q=test&page=1&sort=date'
					);
				});
				it('should handle URLs with special characters in query parameters', () => {
					const content = '[Encode](https://example.com/api?data=%7B%22key%22%3A%22value%22%7D)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toContain('data=');
				});
				it('should handle URLs with plus signs in query', () => {
					const content = '[Query](https://example.com/search?q=hello+world)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe('https://example.com/search?q=hello+world');
				});
			});
			describe('URLs with fragments', () => {
				it('should handle URLs with fragment identifiers', () => {
					const content = '[Section](https://example.com/page#section-2)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe('https://example.com/page#section-2');
				});
				it('should handle URLs with both query and fragment', () => {
					const content = '[Full](https://example.com/page?id=123#heading)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe('https://example.com/page?id=123#heading');
				});
			});
			describe('URLs with special domains', () => {
				it('should handle URLs with port numbers', () => {
					const content = '[Local](https://localhost:3000/api/test)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('localhost');
				});
				it('should handle URLs with IP addresses', () => {
					const content = '[Server](https://192.168.1.1:8080/admin)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('192.168.1.1');
				});
				it('should handle URLs with authentication info', () => {
					const content = '[Auth](https://user:pass@example.com/secure)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('example.com');
				});
			});
			describe('URLs with Unicode and special characters', () => {
				it('should handle URLs with percent-encoded characters', () => {
					const content = '[Encoded](https://example.com/path%20with%20spaces)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toBe('https://example.com/path%20with%20spaces');
				});
				it('should handle URLs with unicode path segments', () => {
					const content = '[Unicode](https://example.com/\u6587\u6863/\u6D4B\u8BD5)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toContain('\u6587\u6863');
				});
				it('should handle URLs with emoji in path', () => {
					const content = '[Emoji](https://example.com/docs/\uD83C\uDF89/welcome)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toContain('\uD83C\uDF89');
				});
				it('should handle URLs with hyphens and underscores', () => {
					const content = '[Dashes](https://my-site.example.com/path_to/some-file)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('my-site.example.com');
				});
			});
			describe('complex real-world URLs', () => {
				it('should handle GitHub file URLs', () => {
					const content = '[Code](https://github.com/user/repo/blob/main/src/index.ts#L10-L20)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toContain('#L10-L20');
					expect(result.externalLinks[0].domain).toBe('github.com');
				});
				it('should handle Google search URLs', () => {
					const content = '[Google](https://www.google.com/search?q=markdown+tutorial&source=hp)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('google.com');
				});
				it('should handle YouTube URLs with video IDs', () => {
					const content = '[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].url).toContain('dQw4w9WgXcQ');
				});
				it('should handle Amazon product URLs', () => {
					const content = '[Product](https://www.amazon.com/dp/B08N5WRWNW?ref=cm_sw_r_cp_api)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('amazon.com');
				});
				it('should handle Stack Overflow question URLs', () => {
					const content =
						'[Question](https://stackoverflow.com/questions/12345678/how-to-do-something)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('stackoverflow.com');
				});
				it('should handle Twitter/X status URLs', () => {
					const content = '[Tweet](https://twitter.com/user/status/1234567890123456789)';
					const result = parseMarkdownLinks(content, 'readme.md');
					expect(result.externalLinks).toHaveLength(1);
					expect(result.externalLinks[0].domain).toBe('twitter.com');
				});
			});
		});
		// -----------------------------------------------------------------------
		// File-tree-aware fallback resolution (allFiles option)
		// -----------------------------------------------------------------------
		describe('file-tree-aware fallback resolution', () => {
			const allFiles = [
				'Market Research/INDEX.md',
				'Market Research/Vendors/PlexTrac.md',
				'Market Research/Vendors/AttackForge.md',
				'Market Research/Competitors/Cyver-Core.md',
				'notes/readme.md',
				'docs/guide.md',
				'docs/advanced/config.md',
				'standalone.md',
			];
			const options: ParseMarkdownLinksOptions = { allFiles };
			it('should resolve wiki links to files in different directories', () => {
				const content = 'See [[PlexTrac]] and [[AttackForge]] for vendor details.';
				const result = parseMarkdownLinks(content, 'Market Research/INDEX.md', options);
				expect(result.internalLinks).toContain('Market Research/Vendors/PlexTrac.md');
				expect(result.internalLinks).toContain('Market Research/Vendors/AttackForge.md');
			});
			it('should resolve wiki links with partial paths via fallback', () => {
				const content = 'See [[Competitors/Cyver-Core]] for details.';
				const result = parseMarkdownLinks(content, 'Market Research/INDEX.md', options);
				expect(result.internalLinks).toContain('Market Research/Competitors/Cyver-Core.md');
			});
			it('should prefer relative resolution when file exists at relative path', () => {
				// If a file exists at the relative path, use it directly (no fallback needed)
				const content = '[[guide]]';
				const result = parseMarkdownLinks(content, 'docs/readme.md', {
					allFiles: ['docs/guide.md', 'other/guide.md'],
				});
				expect(result.internalLinks).toContain('docs/guide.md');
			});
			it('should fall back to filename match when relative path not in file tree', () => {
				// File at relative path "somedir/guide.md" doesn't exist, but "docs/guide.md" does
				const content = '[[guide]]';
				const result = parseMarkdownLinks(content, 'somedir/index.md', {
					allFiles: ['docs/guide.md'],
				});
				expect(result.internalLinks).toContain('docs/guide.md');
			});
			it('should resolve standard markdown links via fallback', () => {
				const content = '[PlexTrac](PlexTrac.md)';
				const result = parseMarkdownLinks(content, 'Market Research/INDEX.md', options);
				expect(result.internalLinks).toContain('Market Research/Vendors/PlexTrac.md');
			});
			it('should pick closest match when multiple files share a filename', () => {
				const content = '[[readme]]';
				// From Market Research directory, "notes/readme.md" is equally far;
				// the important thing is it resolves to something valid
				const result = parseMarkdownLinks(content, 'docs/index.md', {
					allFiles: ['docs/readme.md', 'notes/readme.md'],
				});
				// Should prefer docs/readme.md since it shares the docs/ prefix with the current file
				expect(result.internalLinks).toContain('docs/readme.md');
			});
			it('should still work without allFiles (backward compatible)', () => {
				const content = 'See [[other-doc]] for more info.';
				const result = parseMarkdownLinks(content, 'docs/readme.md');
				// Without allFiles, resolves relative to current file
				expect(result.internalLinks).toContain('docs/other-doc.md');
			});
			it('should handle wiki link that resolves nowhere even with fallback', () => {
				const content = '[[nonexistent-document]]';
				const result = parseMarkdownLinks(content, 'docs/readme.md', options);
				// Should still include the relative resolution (docs/nonexistent-document.md)
				// even though it's not in allFiles - the parser doesn't filter by existence
				expect(result.internalLinks).toHaveLength(1);
			});
			it('should deduplicate when relative and fallback resolve to same path', () => {
				const content = '[[standalone]]';
				const result = parseMarkdownLinks(content, 'index.md', {
					allFiles: ['standalone.md'],
				});
				// relative resolves to standalone.md, which is in allFiles - no fallback needed
				expect(result.internalLinks).toHaveLength(1);
				expect(result.internalLinks).toContain('standalone.md');
			});
		});
	});
});
// Source: src/__tests__/renderer/utils/mediaFloatGeometry.test.ts
describe('', () => {
	const VIEW = { width: 1600, height: 900 };
	const CHROME = mediaFloatChromeHeight(null);
	const audioFit: MediaFloatFit = {
		kind: 'audio',
		aspect: DEFAULT_MEDIA_ASPECT,
		chromeHeight: CHROME,
	};
	const videoFit: MediaFloatFit = {
		kind: 'video',
		aspect: DEFAULT_MEDIA_ASPECT,
		chromeHeight: CHROME,
	};
	describe('mediaFloatChromeHeight', () => {
		it('uses the measured transport when there is one', () => {
			expect(mediaFloatChromeHeight(70)).toBe(MEDIA_FLOAT_TITLE_BAR_HEIGHT + 70);
		});
		it('falls back before anything has been measured', () => {
			// jsdom and the first paint both report nothing; a zero-height chrome would
			// collapse the widget to a sliver.
			expect(mediaFloatChromeHeight(null)).toBe(
				MEDIA_FLOAT_TITLE_BAR_HEIGHT + MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT
			);
			expect(mediaFloatChromeHeight(0)).toBe(mediaFloatChromeHeight(null));
		});
	});
	describe('normalizeMediaAspect', () => {
		it('keeps a real ratio', () => {
			expect(normalizeMediaAspect(4 / 3)).toBeCloseTo(4 / 3);
			// Vertical phone video.
			expect(normalizeMediaAspect(9 / 16)).toBeCloseTo(9 / 16);
		});
		it('falls back to 16:9 for anything unusable', () => {
			expect(normalizeMediaAspect(0)).toBe(DEFAULT_MEDIA_ASPECT);
			expect(normalizeMediaAspect(Number.NaN)).toBe(DEFAULT_MEDIA_ASPECT);
			expect(normalizeMediaAspect(undefined)).toBe(DEFAULT_MEDIA_ASPECT);
		});
		it('refuses a ratio that would shape the widget like a ruler', () => {
			expect(normalizeMediaAspect(50)).toBe(4);
			expect(normalizeMediaAspect(0.01)).toBe(0.25);
		});
	});
	describe('mediaFloatHeight', () => {
		it('collapses audio to the chrome, since it has no picture', () => {
			expect(mediaFloatHeight(audioFit, 380)).toBe(CHROME);
			// Width does not change it: there is nothing to be proportional to.
			expect(mediaFloatHeight(audioFit, 900)).toBe(CHROME);
		});
		it('gives video exactly its own aspect ratio, so it never letterboxes', () => {
			expect(mediaFloatHeight(videoFit, 560)).toBe(CHROME + 315);
			expect(mediaFloatHeight({ ...videoFit, aspect: 4 / 3 }, 560)).toBe(CHROME + 420);
			expect(mediaFloatHeight({ ...videoFit, aspect: 9 / 16 }, 360)).toBe(CHROME + 640);
		});
	});
	describe('fitMediaFloatRect', () => {
		it('derives the height rather than taking one', () => {
			const rect = fitMediaFloatRect({ top: 100, left: 200, width: 560 }, videoFit, VIEW);
			expect(rect.height).toBe(CHROME + 315);
			expect(rect.top).toBe(100);
			expect(rect.left).toBe(200);
		});
		it('pulls a rect back on screen from the right and bottom', () => {
			const rect = fitMediaFloatRect({ top: 880, left: 1560, width: 400 }, audioFit, VIEW);
			expect(rect.left).toBe(1200);
			expect(rect.top).toBe(900 - CHROME);
		});
		it('pulls a rect back from negative coordinates', () => {
			const rect = fitMediaFloatRect({ top: -50, left: -80, width: 400 }, audioFit, VIEW);
			expect(rect.left).toBe(0);
			expect(rect.top).toBe(0);
		});
		it('keeps the header below the title strip, healing a position stuck under it', () => {
			// The title strip is an OS drag region that eats clicks; a stored top of 0
			// left the player unmovable and unclosable.
			const rect = fitMediaFloatRect({ top: 0, left: 200, width: 400 }, audioFit, {
				...VIEW,
				top: 40,
			});
			expect(rect.top).toBe(40);
		});
		it('shrinks a tall video to the band below the title strip', () => {
			const rect = fitMediaFloatRect({ top: 0, left: 0, width: 1600 }, videoFit, {
				width: 1600,
				height: 500,
				top: 40,
			});
			expect(rect.top).toBe(40);
			expect(rect.top + rect.height).toBeLessThanOrEqual(500);
		});
		it('recovers a position persisted on a larger monitor', () => {
			// The whole reason this clamping exists: geometry saved at 2560x1440 must
			// not leave the widget off screen on a laptop.
			const rect = fitMediaFloatRect({ top: 1300, left: 2400, width: 480 }, videoFit, {
				width: 1280,
				height: 800,
			});
			expect(rect.left).toBeGreaterThanOrEqual(0);
			expect(rect.top).toBeGreaterThanOrEqual(0);
			expect(rect.left + rect.width).toBeLessThanOrEqual(1280);
			expect(rect.top + rect.height).toBeLessThanOrEqual(800);
		});
		it('enforces the minimum width', () => {
			expect(fitMediaFloatRect({ top: 0, left: 0, width: 40 }, audioFit, VIEW).width).toBe(
				MEDIA_FLOAT_MIN_WIDTH
			);
		});
		it('narrows a tall video instead of running it off the bottom', () => {
			// A 9:16 clip at a wide width would be taller than the screen. The picture
			// stays whole, just smaller.
			const view = { width: 1600, height: 700 };
			const rect = fitMediaFloatRect(
				{ top: 0, left: 0, width: 900 },
				{ ...videoFit, aspect: 9 / 16 },
				view
			);
			expect(rect.height).toBeLessThanOrEqual(view.height);
			expect(rect.width).toBeLessThan(900);
		});
		it('lets a viewport smaller than the frame win, rather than going off screen', () => {
			const rect = fitMediaFloatRect({ top: 0, left: 0, width: 400 }, audioFit, {
				width: 200,
				height: 80,
			});
			expect(rect.width).toBe(200);
			expect(rect.height).toBe(80);
			expect(rect.left).toBe(0);
			expect(rect.top).toBe(0);
		});
	});
	describe('initialMediaFloatRect', () => {
		it('parks audio bottom-right as a control strip', () => {
			const rect = initialMediaFloatRect(audioFit, VIEW);
			expect(rect.width).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.audio);
			expect(rect.height).toBe(CHROME);
			expect(rect.left).toBe(VIEW.width - rect.width - MEDIA_FLOAT_EDGE_MARGIN);
			expect(rect.top).toBe(VIEW.height - rect.height - MEDIA_FLOAT_EDGE_MARGIN);
		});
		it('opens video wide enough to actually watch', () => {
			const rect = initialMediaFloatRect(videoFit, VIEW);
			expect(rect.width).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.video);
			expect(rect.width).toBeGreaterThan(MEDIA_FLOAT_DEFAULT_WIDTH.audio);
			// The stage is the file's own shape, not a guess at a box.
			expect(rect.height - CHROME).toBe(Math.round(rect.width / DEFAULT_MEDIA_ASPECT));
		});
		it('stays on screen in a viewport smaller than the default', () => {
			const rect = initialMediaFloatRect(videoFit, { width: 320, height: 200 });
			expect(rect.left).toBe(0);
			expect(rect.top).toBe(0);
			expect(rect.width).toBeLessThanOrEqual(320);
			expect(rect.height).toBeLessThanOrEqual(200);
		});
	});
	describe('mediaFloatWidthFor', () => {
		it('uses the width the user chose for that kind', () => {
			expect(mediaFloatWidthFor('video', { audio: 400, video: 900 })).toBe(900);
		});
		it('falls back to the kind default rather than the other kind width', () => {
			// Carrying a movie's width onto an MP3 would make a control strip half the
			// screen wide.
			expect(mediaFloatWidthFor('audio', { video: 900 })).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.audio);
			expect(mediaFloatWidthFor('video', {})).toBe(MEDIA_FLOAT_DEFAULT_WIDTH.video);
		});
	});
	describe('mediaFloatResizeWidth', () => {
		const origin = { width: 560, height: CHROME + 315 };
		it('takes the horizontal drag for audio, since height is not a dimension', () => {
			expect(mediaFloatResizeWidth(origin, { dx: 40, dy: 200 }, audioFit)).toBe(600);
		});
		it('lets a downward corner drag grow a video, with the aspect kept', () => {
			// The grip is a corner. Dragging it down must do something, even though
			// height follows the picture rather than the cursor.
			const width = mediaFloatResizeWidth(origin, { dx: 0, dy: 90 }, videoFit);
			expect(width).toBeCloseTo(origin.width + 90 * DEFAULT_MEDIA_ASPECT);
		});
		it('follows whichever axis the user moved further', () => {
			expect(mediaFloatResizeWidth(origin, { dx: 300, dy: 10 }, videoFit)).toBe(860);
		});
	});
	describe('sanitizeMediaFloat', () => {
		it('keeps a position and its per-kind widths', () => {
			expect(sanitizeMediaFloat({ top: 10, left: 20, widths: { audio: 400, video: 800 } })).toEqual(
				{
					top: 10,
					left: 20,
					widths: { audio: 400, video: 800 },
				}
			);
		});
		it('keeps the position of the older full-rect shape but drops its width', () => {
			// That width was saved without recording which kind it belonged to, so
			// applying it would size a podcast like a movie half the time.
			expect(sanitizeMediaFloat({ top: 10, left: 20, width: 480, height: 336 })).toEqual({
				top: 10,
				left: 20,
				widths: {},
			});
		});
		it('drops widths that are not usable numbers', () => {
			expect(sanitizeMediaFloat({ top: 0, left: 0, widths: { audio: -1, video: 'wide' } })).toEqual(
				{
					top: 0,
					left: 0,
					widths: {},
				}
			);
		});
		it('rejects anything without a position', () => {
			expect(sanitizeMediaFloat(null)).toBeNull();
			expect(sanitizeMediaFloat({ widths: { audio: 400 } })).toBeNull();
			expect(sanitizeMediaFloat('nope')).toBeNull();
		});
	});
	describe('mediaFloatFootprint', () => {
		it("re-expresses a rect in the bottom-right lane's coordinates", () => {
			expect(mediaFloatFootprint({ top: 700, left: 1100, width: 380, height: 132 }, VIEW)).toEqual({
				// 900 - 700: how tall a bottom-anchored stack has to be to reach the top
				// edge of the widget.
				fromBottom: 200,
				// 1600 - (1100 + 380)
				fromRight: 120,
				width: 380,
				viewportHeight: 900,
			});
		});
	});
	describe('mediaFloatLaneLift', () => {
		const lane: MediaFloatBottomLane = { fromRight: 16, width: 400, gap: 8 };
		it('lifts a toast stack clear of a player parked in the same corner', () => {
			// The default opening position: this is the case where an arriving toast
			// painted over the widget and it read as the player closing itself.
			const rect = initialMediaFloatRect(audioFit, VIEW);
			const lift = mediaFloatLaneLift(mediaFloatFootprint(rect, VIEW), lane);
			expect(lift).toBe(MEDIA_FLOAT_EDGE_MARGIN + CHROME + lane.gap);
			// Clear of the widget's top edge, not merely level with it.
			expect(lift).toBeGreaterThan(VIEW.height - rect.top);
		});
		it('does not move for a player in another column', () => {
			// Dragged to the bottom LEFT: the stack and the widget never touch, so
			// lifting would displace toasts for nothing.
			const footprint = mediaFloatFootprint({ top: 750, left: 24, width: 380, height: 132 }, VIEW);
			expect(mediaFloatLaneLift(footprint, lane)).toBe(0);
		});
		it('lifts for a player that only clips the edge of the lane', () => {
			// Widget's right edge lands 400px in from the window edge, one pixel inside
			// the lane's left boundary.
			const footprint = mediaFloatFootprint({ top: 750, left: 820, width: 380, height: 132 }, VIEW);
			expect(footprint.fromRight).toBe(400);
			expect(mediaFloatLaneLift(footprint, lane)).toBeGreaterThan(0);
		});
		it('stays put when the player is too high up to clear', () => {
			// A widget dragged near the top cannot be stepped over - raising the lane
			// that far would push toasts off the top of the window.
			const footprint = mediaFloatFootprint({ top: 40, left: 1200, width: 380, height: 132 }, VIEW);
			expect(footprint.fromBottom).toBeGreaterThan(VIEW.height * MEDIA_FLOAT_LANE_LIFT_RATIO);
			expect(mediaFloatLaneLift(footprint, lane)).toBe(0);
		});
		it('treats a viewport-spanning lane as always sharing the column', () => {
			// The phone stack is pinned to both edges, so no widget position can miss it.
			const footprint = mediaFloatFootprint({ top: 750, left: 24, width: 380, height: 132 }, VIEW);
			expect(
				mediaFloatLaneLift(footprint, { fromRight: 12, width: Number.POSITIVE_INFINITY, gap: 8 })
			).toBeGreaterThan(0);
		});
		it('does not move when there is no player on screen', () => {
			expect(mediaFloatLaneLift(null, lane)).toBe(0);
		});
	});
});
// Source: src/__tests__/renderer/utils/openUiSurface.test.ts
describe('', () => {
	describe('openUiSurface - feedback', () => {
		beforeEach(() => {
			useModalStore.getState().closeModal('feedback');
			useFeedbackDraftStore.getState().reset();
		});
		it('opens the Send Feedback modal', () => {
			expect(openUiSurface('feedback')).toEqual({ ok: true });
			expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
		});
		it('restores a minimized draft rather than opening a fresh modal', () => {
			useModalStore.getState().openModal('feedback');
			useFeedbackDraftStore.getState().setMinimized(true);
			expect(openUiSurface('feedback')).toEqual({ ok: true });
			expect(useFeedbackDraftStore.getState().isMinimized).toBe(false);
			expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
		});
	});
	describe('openUiSurface - quick-chat', () => {
		it('shows the Quick Chat window through the main process, not as a modal', () => {
			const show = vi.mocked(window.maestro.quickChat.window);
			show.mockClear();
			expect(openUiSurface('quick-chat')).toEqual({ ok: true });
			expect(show).toHaveBeenCalledWith('show');
		});
	});
	describe('openUiSurface - throughput-gauge', () => {
		const initialEncore = useSettingsStore.getState().encoreFeatures;
		const setGaugeFlag = (on: boolean) =>
			useSettingsStore.setState((s) => ({
				encoreFeatures: { ...s.encoreFeatures, throughputGauge: on },
			}));
		beforeEach(() => {
			useThroughputGaugeStore.setState({ visible: false });
		});
		afterEach(() => {
			useSettingsStore.setState({ encoreFeatures: initialEncore });
		});
		it('shows the floating gauge through its own store, not as a modal', () => {
			setGaugeFlag(true);
			expect(openUiSurface('throughput-gauge')).toEqual({ ok: true });
			expect(useThroughputGaugeStore.getState().visible).toBe(true);
		});
		it('resolves the gauge by its aliases', () => {
			setGaugeFlag(true);
			expect(openUiSurface('tps')).toEqual({ ok: true });
			expect(useThroughputGaugeStore.getState().visible).toBe(true);
		});
		it('refuses while the Encore Feature is off, reporting to the caller only', () => {
			setGaugeFlag(false);
			const toastsBefore = useNotificationStore.getState().toasts.length;
			const result = openUiSurface('throughput-gauge');
			expect(result.ok).toBe(false);
			expect(result.error).toContain('Settings → Plugins');
			expect(useThroughputGaugeStore.getState().visible).toBe(false);
			// No in-app toast advertising the disabled feature.
			expect(useNotificationStore.getState().toasts.length).toBe(toastsBefore);
		});
	});
	describe('openUiSurface - Encore-gated tabs', () => {
		const initialEncore = useSettingsStore.getState().encoreFeatures;
		afterEach(() => {
			useSettingsStore.setState({ encoreFeatures: initialEncore });
			useModalStore.getState().closeModal('usageDashboard');
		});
		it("refuses the Usage Dashboard's Cue tab while Cue is off", () => {
			useSettingsStore.setState((s) => ({
				encoreFeatures: { ...s.encoreFeatures, usageStats: true, maestroCue: false },
			}));
			const result = openUiSurface('usage-dashboard', 'cue');
			expect(result.ok).toBe(false);
			expect(result.error).toContain('Cue');
			expect(selectModalOpen('usageDashboard')(useModalStore.getState())).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/utils/quoteSelection.test.ts
describe('', () => {
	describe('formatMarkdownQuote', () => {
		it('prefixes every line and keeps inner blank lines inside the quote', () => {
			expect(formatMarkdownQuote('one\n\ntwo')).toBe('> one\n>\n> two');
		});
		it('drops surrounding blank lines and normalizes CRLF', () => {
			expect(formatMarkdownQuote('\r\n  \r\nline one\r\nline two  \r\n\r\n')).toBe(
				'> line one\n> line two'
			);
		});
		it('returns an empty string for a whitespace-only selection', () => {
			expect(formatMarkdownQuote(' \n\t\n')).toBe('');
		});
	});
	describe('appendQuoteToDraft', () => {
		it('quotes into an empty draft with a blank line after for the comment', () => {
			expect(appendQuoteToDraft('', 'passage')).toBe('> passage\n\n');
		});
		it('appends below existing text separated by one blank line', () => {
			expect(appendQuoteToDraft('> a\n\ncomment on a\n', 'b')).toBe(
				'> a\n\ncomment on a\n\n> b\n\n'
			);
		});
		it('leaves the draft unchanged for an empty selection', () => {
			expect(appendQuoteToDraft('draft', '   ')).toBe('draft');
		});
	});
});
