import { describe, it, expect } from 'vitest';
import {
	TEXT_PAGE_CLASS,
	TEXT_PAGE_GUTTER_CLASS,
	TEXT_PAGE_CONTENT_CLASS,
	generateTextProseCss,
} from '../../../../../renderer/components/FilePreview/textFast/proseStyles';
import { createMockTheme } from '../../../../helpers/mockTheme';
import type { ThemeColors } from '../../../../../shared/theme-types';

const makeTheme = (overrides: Partial<ThemeColors> = {}) => createMockTheme({ colors: overrides });

describe('TEXT_PAGE_* class constants', () => {
	it('exports stable class names', () => {
		expect(TEXT_PAGE_CLASS).toBe('text-fast-page');
		expect(TEXT_PAGE_GUTTER_CLASS).toBe('text-fast-gutter');
		expect(TEXT_PAGE_CONTENT_CLASS).toBe('text-fast-content');
	});
});

describe('generateTextProseCss', () => {
	it('returns a non-empty CSS string', () => {
		const css = generateTextProseCss(makeTheme());
		expect(css.length).toBeGreaterThan(0);
	});

	it('scopes every rule to one of the text-fast class names', () => {
		const css = generateTextProseCss(makeTheme());
		const ruleLines = css.split('\n').filter((line) => line.trim() && line.includes('{'));
		for (const line of ruleLines) {
			const hit =
				line.includes(`.${TEXT_PAGE_CLASS}`) ||
				line.includes(`.${TEXT_PAGE_GUTTER_CLASS}`) ||
				line.includes(`.${TEXT_PAGE_CONTENT_CLASS}`);
			expect(hit).toBe(true);
		}
	});

	it('embeds the theme textMain in the page color', () => {
		const css = generateTextProseCss(makeTheme({ textMain: '#aabbcc' }));
		expect(css).toContain('color: #aabbcc');
	});

	it('embeds the theme textDim in the gutter', () => {
		const css = generateTextProseCss(makeTheme({ textDim: '#778899' }));
		expect(css).toMatch(/text-fast-gutter\s*\{[^}]*#778899/);
	});

	it('embeds the theme border between gutter and content', () => {
		const css = generateTextProseCss(makeTheme({ border: '#abcdef' }));
		expect(css).toContain('#abcdef');
	});

	it('uses a monospace font stack', () => {
		const css = generateTextProseCss(makeTheme());
		expect(css.toLowerCase()).toContain('monospace');
	});

	it('disables user-select on the gutter so line numbers do not copy', () => {
		const css = generateTextProseCss(makeTheme());
		expect(css).toMatch(/text-fast-gutter\s*\{[^}]*user-select:\s*none/);
	});

	it('declares grid layout on the page container', () => {
		const css = generateTextProseCss(makeTheme());
		expect(css).toContain('display: grid');
		expect(css).toContain('grid-template-columns');
	});

	it('produces different output when the theme changes', () => {
		const a = generateTextProseCss(makeTheme({ textMain: '#000' }));
		const b = generateTextProseCss(makeTheme({ textMain: '#fff' }));
		expect(a).not.toBe(b);
	});
});
