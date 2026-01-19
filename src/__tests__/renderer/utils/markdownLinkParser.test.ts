/**
 * Tests for markdown link parser utility
 */

import {
	parseMarkdownLinks,
	extractDomain,
	type ParsedMarkdownLinks,
} from '../../../renderer/utils/markdownLinkParser';

describe('extractDomain', () => {
	it('should extract domain from HTTPS URL', () => {
		expect(extractDomain('https://github.com/user/repo')).toBe('github.com');
	});

	it('should extract domain from HTTP URL', () => {
		expect(extractDomain('http://example.com/page')).toBe('example.com');
	});

	it('should strip www. prefix', () => {
		expect(extractDomain('https://www.github.com/user/repo')).toBe('github.com');
	});

	it('should handle URLs with port numbers', () => {
		expect(extractDomain('https://localhost:3000/path')).toBe('localhost');
	});

	it('should handle URLs with query parameters', () => {
		expect(extractDomain('https://example.com/path?query=value')).toBe('example.com');
	});

	it('should handle subdomain URLs', () => {
		expect(extractDomain('https://docs.github.com/en/pages')).toBe('docs.github.com');
	});

	it('should return original string for invalid URLs', () => {
		expect(extractDomain('not-a-url')).toBe('not-a-url');
	});
});

describe('parseMarkdownLinks', () => {
	describe('wiki-style links', () => {
		it('should parse simple wiki links [[filename]]', () => {
			const content = 'See [[other-doc]] for more info.';
			const result = parseMarkdownLinks(content, 'docs/readme.md');

			expect(result.internalLinks).toContain('docs/other-doc.md');
			expect(result.externalLinks).toHaveLength(0);
		});

		it('should parse wiki links with display text [[path|text]]', () => {
			const content = 'Check out [[getting-started|the guide]].';
			const result = parseMarkdownLinks(content, 'docs/readme.md');

			expect(result.internalLinks).toContain('docs/getting-started.md');
		});

		it('should parse wiki links with folders [[Folder/Note]]', () => {
			const content = 'See [[subdir/nested-doc]] for details.';
			const result = parseMarkdownLinks(content, 'docs/readme.md');

			expect(result.internalLinks).toContain('docs/subdir/nested-doc.md');
		});

		it('should skip image embeds', () => {
			const content = '![[screenshot.png]] and [[doc-link]]';
			const result = parseMarkdownLinks(content, 'docs/readme.md');

			expect(result.internalLinks).toContain('docs/doc-link.md');
			expect(result.internalLinks).toHaveLength(1);
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

	describe('standard markdown links', () => {
		it('should parse internal markdown links [text](path.md)', () => {
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

		it('should skip anchor links', () => {
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
	});

	describe('front matter parsing', () => {
		it('should parse YAML front matter', () => {
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

		it('should handle boolean values in front matter', () => {
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

		it('should handle quoted strings in front matter', () => {
			const content = `---
title: "Quoted Title"
subtitle: 'Single quoted'
---

Content
`;
			const result = parseMarkdownLinks(content, 'doc.md');

			expect(result.frontMatter.title).toBe('Quoted Title');
			expect(result.frontMatter.subtitle).toBe('Single quoted');
		});

		it('should return empty object when no front matter', () => {
			const content = '# Just a heading\n\nSome content.';
			const result = parseMarkdownLinks(content, 'doc.md');

			expect(result.frontMatter).toEqual({});
		});

		it('should ignore comments in front matter', () => {
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
	});

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
	});

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
	});

	describe('edge cases', () => {
		it('should handle empty content', () => {
			const result = parseMarkdownLinks('', 'doc.md');

			expect(result.internalLinks).toHaveLength(0);
			expect(result.externalLinks).toHaveLength(0);
			expect(result.frontMatter).toEqual({});
		});

		it('should handle URL-encoded paths', () => {
			const content = '[doc](./my%20document.md)';
			const result = parseMarkdownLinks(content, 'readme.md');

			expect(result.internalLinks).toContain('my document.md');
		});

		it('should handle files at root level', () => {
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

	describe('malformed markdown handling (graceful degradation)', () => {
		describe('null/undefined/invalid input handling', () => {
			it('should handle null content without crashing', () => {
				// @ts-expect-error Testing runtime behavior with null input
				const result = parseMarkdownLinks(null, 'doc.md');

				expect(result.internalLinks).toEqual([]);
				expect(result.externalLinks).toEqual([]);
				expect(result.frontMatter).toEqual({});
			});

			it('should handle undefined content without crashing', () => {
				// @ts-expect-error Testing runtime behavior with undefined input
				const result = parseMarkdownLinks(undefined, 'doc.md');

				expect(result.internalLinks).toEqual([]);
				expect(result.externalLinks).toEqual([]);
				expect(result.frontMatter).toEqual({});
			});

			it('should handle non-string content types without crashing', () => {
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

				// Should still parse links (using empty string as base path)
				expect(result.internalLinks).toContain('other-doc.md');
			});
		});

		describe('malformed URL encoding', () => {
			it('should handle invalid percent-encoded URLs gracefully', () => {
				// %ZZ is invalid percent encoding - should not crash
				const content = '[doc](./my%ZZdocument.md)';
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should use the original path when decoding fails
				expect(result.internalLinks).toContain('my%ZZdocument.md');
			});

			it('should handle incomplete percent encoding', () => {
				// % at end of string is incomplete encoding
				const content = '[doc](./document%.md)';
				const result = parseMarkdownLinks(content, 'readme.md');

				expect(result.internalLinks).toHaveLength(1);
				expect(result.internalLinks[0]).toContain('document');
			});

			it('should handle multiple invalid percent sequences', () => {
				const content = '[doc](./my%ZZ%YYdocument%XXtest.md)';
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should not crash and should extract some link
				expect(result.internalLinks).toHaveLength(1);
			});
		});

		describe('malformed front matter', () => {
			it('should handle front matter with only opening delimiter', () => {
				const content = `---
title: No closing delimiter
Some content here.`;
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should not crash, should return empty front matter
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

				// Should not crash
				expect(result).toBeDefined();
				expect(result.frontMatter).toBeDefined();
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

				// Should not crash
				expect(result).toBeDefined();
			});
		});

		describe('malformed wiki links', () => {
			it('should handle empty wiki links [[]]', () => {
				const content = 'See [[]] and [[valid-link]].';
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should skip empty and process valid
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

				// Should not crash, should find the closed link
				expect(result).toBeDefined();
			});

			it('should handle nested brackets in wiki links', () => {
				const content = 'See [[link[with]brackets]].';
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should not crash
				expect(result).toBeDefined();
			});

			it('should handle wiki links with special characters', () => {
				const content = 'See [[link-with-émojis-🎉]] and [[日本語リンク]].';
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should not crash and should parse the links
				expect(result.internalLinks).toHaveLength(2);
			});
		});

		describe('malformed markdown links', () => {
			it('should handle empty markdown links []()', () => {
				const content = 'See []() and [text](./valid.md).';
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should process valid link
				expect(result.internalLinks).toContain('valid.md');
			});

			it('should handle markdown links with no URL [text]()', () => {
				const content = 'See [text with no url]() here.';
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should not crash
				expect(result).toBeDefined();
			});

			it('should handle unclosed markdown links', () => {
				const content = 'See [unclosed link(./file.md and [closed](./valid.md).';
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should find valid link and not crash
				expect(result.internalLinks).toContain('valid.md');
			});

			it('should handle markdown links with newlines inside', () => {
				const content = `See [text
with newline](./file.md).`;
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should not crash
				expect(result).toBeDefined();
			});

			it('should handle very long link URLs', () => {
				const longPath = 'a'.repeat(10000) + '.md';
				const content = `See [link](./${longPath}).`;
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should not crash
				expect(result).toBeDefined();
			});
		});

		describe('binary and special content', () => {
			it('should handle content with null bytes', () => {
				const content = 'Some text\x00with null\x00bytes [[link]].';
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should not crash
				expect(result).toBeDefined();
			});

			it('should handle content with control characters', () => {
				const content = 'Text\x01\x02\x03\x04\x05 with [[link]] control chars.';
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should not crash and parse link
				expect(result.internalLinks).toContain('link.md');
			});

			it('should handle content with mixed line endings', () => {
				const content = 'Line1\rLine2\r\nLine3\nLine4\r\n[[link]]';
				const result = parseMarkdownLinks(content, 'doc.md');

				expect(result.internalLinks).toContain('link.md');
			});

			it('should handle extremely long content without hanging', () => {
				// 1MB of content
				const longContent = 'x'.repeat(1024 * 1024) + '[[link]]';
				const result = parseMarkdownLinks(longContent, 'doc.md');

				expect(result.internalLinks).toContain('link.md');
			});
		});

		describe('edge case combinations', () => {
			it('should handle content that is only delimiters', () => {
				const content = '---\n---';
				const result = parseMarkdownLinks(content, 'doc.md');

				expect(result.frontMatter).toEqual({});
			});

			it('should handle deeply nested bracket patterns', () => {
				const content = '[[[[[[nested]]]]]]';
				const result = parseMarkdownLinks(content, 'doc.md');

				// Should not crash (may or may not extract links depending on pattern)
				expect(result).toBeDefined();
			});

			it('should handle interleaved wiki and markdown links', () => {
				const content = '[[wiki-[nested](./md.md)-link]] and [md-[[wiki]]-link](./file.md)';
				const result = parseMarkdownLinks(content, 'readme.md');

				// Should not crash
				expect(result).toBeDefined();
			});

			it('should handle content starting and ending with brackets', () => {
				const content = '[[start]] content [[end]]';
				const result = parseMarkdownLinks(content, 'doc.md');

				expect(result.internalLinks).toContain('start.md');
				expect(result.internalLinks).toContain('end.md');
			});
		});
	});

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
				expect(result.externalLinks[0].url).toBe('https://example.com/wiki/Term_(disambiguation)');
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
				const content = '[Unicode](https://example.com/文档/测试)';
				const result = parseMarkdownLinks(content, 'readme.md');

				expect(result.externalLinks).toHaveLength(1);
				expect(result.externalLinks[0].url).toContain('文档');
			});

			it('should handle URLs with emoji in path', () => {
				const content = '[Emoji](https://example.com/docs/🎉/welcome)';
				const result = parseMarkdownLinks(content, 'readme.md');

				expect(result.externalLinks).toHaveLength(1);
				expect(result.externalLinks[0].url).toContain('🎉');
			});

			it('should handle URLs with hyphens and underscores', () => {
				const content = '[Dashes](https://my-site.example.com/path_to/some-file)';
				const result = parseMarkdownLinks(content, 'readme.md');

				expect(result.externalLinks).toHaveLength(1);
				expect(result.externalLinks[0].domain).toBe('my-site.example.com');
			});
		});

		describe('extractDomain edge cases', () => {
			it('should handle IDN domains (punycode)', () => {
				// The URL constructor converts IDN to punycode
				expect(extractDomain('https://例え.jp/path')).toBe('xn--r8jz45g.jp');
			});

			it('should strip www prefix from complex URLs', () => {
				expect(extractDomain('https://www.docs.example.com/path')).toBe('docs.example.com');
			});

			it('should handle URLs with trailing slashes', () => {
				expect(extractDomain('https://example.com/')).toBe('example.com');
			});

			it('should handle URLs with deep paths', () => {
				expect(extractDomain('https://github.com/org/repo/blob/main/src/file.ts')).toBe(
					'github.com'
				);
			});

			it('should return original for malformed URLs', () => {
				// The regex fallback should handle these
				expect(extractDomain('http://incomplete')).toBe('incomplete');
			});

			it('should handle URLs with unusual TLDs', () => {
				expect(extractDomain('https://site.museum/collection')).toBe('site.museum');
				expect(extractDomain('https://company.technology/product')).toBe('company.technology');
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
});
