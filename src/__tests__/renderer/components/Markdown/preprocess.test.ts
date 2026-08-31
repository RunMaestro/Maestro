import { describe, it, expect } from 'vitest';
import {
	fixMarkdownLinkSpaces,
	hardBreakInlineFields,
	preprocessMarkdown,
} from '../../../../renderer/components/Markdown/preprocess';

describe('fixMarkdownLinkSpaces', () => {
	it('leaves links without spaces untouched', () => {
		const input = 'See [readme](./README.md) and [docs](https://x.com/a)';
		expect(fixMarkdownLinkSpaces(input)).toBe(input);
	});

	it('wraps a URL containing spaces in angle brackets', () => {
		expect(fixMarkdownLinkSpaces('[f](/path/with spaces/file.ts)')).toBe(
			'[f](</path/with spaces/file.ts>)'
		);
	});

	it('handles nested brackets in the label', () => {
		expect(fixMarkdownLinkSpaces('[src/[id].tsx](/a b/c.tsx)')).toBe(
			'[src/[id].tsx](</a b/c.tsx>)'
		);
	});

	it('handles balanced parens inside the URL', () => {
		expect(fixMarkdownLinkSpaces('[file](/path (copy)/file.ts)')).toBe(
			'[file](</path (copy)/file.ts>)'
		);
	});

	it('rewrites multiple links on one line', () => {
		expect(fixMarkdownLinkSpaces('[a](x y) and [b](z w)')).toBe('[a](<x y>) and [b](<z w>)');
	});

	it('falls back to %20 when the URL already contains angle brackets', () => {
		expect(fixMarkdownLinkSpaces('[f](/a <b>/c d.ts)')).toBe('[f](/a%20<b>/c%20d.ts)');
	});

	it('skips unbalanced parens (no rewrite)', () => {
		const input = '[f](/a b/file.ts';
		expect(fixMarkdownLinkSpaces(input)).toBe(input);
	});
});

describe('preprocessMarkdown', () => {
	it('always applies the link-space fix', () => {
		expect(preprocessMarkdown('[f](/a b/c.ts)')).toBe('[f](</a b/c.ts>)');
	});

	it('does not normalize display math unless chatMath is set', () => {
		const input = 'price is $$5 to $$10';
		// Without chatMath the math normalizer is skipped (content passes through link fix only)
		expect(preprocessMarkdown(input)).toBe(input);
	});

	it('normalizes multi-line display math when chatMath is set', () => {
		const input = '$$\n a + b \n$$';
		const out = preprocessMarkdown(input, { chatMath: true });
		// Normalizer keeps delimiters on their own lines; output is a string (no throw)
		expect(typeof out).toBe('string');
		expect(out).toContain('a + b');
	});

	// Raw-HTML sanitization moved to the HAST level (rehype-sanitize). preprocess
	// must NOT touch raw HTML - the old raw-string DOMPurify pass corrupted
	// ordinary content, which is the bug this guards against.
	it('leaves raw HTML untouched (sanitization happens downstream at HAST level)', () => {
		const input = '<p>ok</p><script>alert(1)</script>';
		expect(preprocessMarkdown(input)).toBe(input);
	});

	it('does not corrupt generics in inline code or code fences', () => {
		const input = 'Use `List<int>` and:\n```ts\nconst x: Array<number> = []; if (a < b) {}\n```';
		expect(preprocessMarkdown(input)).toBe(input);
		expect(preprocessMarkdown(input, { chatMath: true })).toContain('Array<number>');
	});
});

describe('hardBreakInlineFields', () => {
	it('breaks a run of Dataview-style inline fields onto their own lines', () => {
		const input = 'Type:: Briefing\nPeriod:: AM\nDate:: 2026-08-28';
		expect(hardBreakInlineFields(input)).toBe(
			'Type:: Briefing  \nPeriod:: AM  \nDate:: 2026-08-28'
		);
	});

	it('separates the field block from prose above and below it', () => {
		const input = 'Intro line\nType:: Briefing\nPeriod:: AM\nTrailing prose';
		expect(hardBreakInlineFields(input)).toBe(
			'Intro line  \nType:: Briefing  \nPeriod:: AM  \nTrailing prose'
		);
	});

	it('leaves a lone field-looking line alone (prose containing ::)', () => {
		const input = 'The syntax is Key:: value\nand it keeps flowing.';
		expect(hardBreakInlineFields(input)).toBe(input);
	});

	it('does not touch C++/Rust scope resolution', () => {
		const input = 'std::vector<int> v;\nstd::sort(v.begin(), v.end());';
		expect(hardBreakInlineFields(input)).toBe(input);
	});

	it('skips fenced code blocks that document the syntax', () => {
		const input = '```\nType:: Briefing\nPeriod:: AM\n```';
		expect(hardBreakInlineFields(input)).toBe(input);
	});

	it('does not double up an existing hard break', () => {
		const input = 'Type:: Briefing  \nPeriod:: AM';
		expect(hardBreakInlineFields(input)).toBe(input);
	});

	it('leaves a field block that is already blank-line separated alone', () => {
		const input = 'Type:: Briefing\n\nPeriod:: AM';
		expect(hardBreakInlineFields(input)).toBe(input);
	});

	it('runs as part of preprocessMarkdown', () => {
		expect(preprocessMarkdown('Type:: Briefing\nPeriod:: AM')).toBe(
			'Type:: Briefing  \nPeriod:: AM'
		);
	});
});
