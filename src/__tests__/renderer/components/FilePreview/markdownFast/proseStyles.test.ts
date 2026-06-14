import { describe, it, expect } from 'vitest';
import {
	FAST_BLOCK_CLASS,
	generateProseCss,
} from '../../../../../renderer/components/FilePreview/markdownFast/proseStyles';
import { createMockTheme } from '../../../../helpers/mockTheme';
import type { ThemeColors } from '../../../../../shared/theme-types';

const makeTheme = (colorOverrides: Partial<ThemeColors> = {}) =>
	createMockTheme({ colors: colorOverrides });

describe('FAST_BLOCK_CLASS', () => {
	it('exports a stable class name used by both the component and the stylesheet', () => {
		expect(FAST_BLOCK_CLASS).toBe('markdown-fast-block');
	});
});

describe('generateProseCss', () => {
	it('returns a non-empty CSS string', () => {
		const css = generateProseCss(makeTheme());
		expect(css).toBeTypeOf('string');
		expect(css.length).toBeGreaterThan(0);
	});

	it('scopes every rule to the FAST_BLOCK_CLASS class', () => {
		const css = generateProseCss(makeTheme());
		// Every non-empty, non-comment line should reference our class
		const ruleLines = css.split('\n').filter((line) => line.trim() && line.includes('{'));
		for (const line of ruleLines) {
			expect(line).toContain(`.${FAST_BLOCK_CLASS}`);
		}
	});

	it('embeds theme accent in h1', () => {
		const css = generateProseCss(makeTheme({ accent: '#deadbe' }));
		expect(css).toContain('color: #deadbe');
		expect(css).toMatch(/h1\s*\{[^}]*#deadbe/);
	});

	it('embeds theme success in h2', () => {
		const css = generateProseCss(makeTheme({ success: '#abcabc' }));
		expect(css).toMatch(/h2\s*\{[^}]*#abcabc/);
	});

	it('embeds theme warning in h3', () => {
		const css = generateProseCss(makeTheme({ warning: '#fed0fe' }));
		expect(css).toMatch(/h3\s*\{[^}]*#fed0fe/);
	});

	it('uses theme bgActivity for code and pre backgrounds', () => {
		const css = generateProseCss(makeTheme({ bgActivity: '#101010' }));
		expect(css).toMatch(/code\s*\{[^}]*background-color:\s*#101010/);
		expect(css).toMatch(/pre\s*\{[^}]*background-color:\s*#101010/);
	});

	it('uses theme border in table cells and hr', () => {
		const css = generateProseCss(makeTheme({ border: '#445566' }));
		expect(css).toContain('#445566');
		expect(css).toMatch(/th,\s*\.markdown-fast-block td\s*\{[^}]*#445566/);
	});

	it('produces different output for different themes', () => {
		const dark = generateProseCss(makeTheme({ accent: '#fff' }));
		const light = generateProseCss(makeTheme({ accent: '#000' }));
		expect(dark).not.toBe(light);
	});

	it('includes table styles', () => {
		const css = generateProseCss(makeTheme());
		expect(css).toContain('table');
		expect(css).toContain('border-collapse');
	});

	it('includes blockquote styles', () => {
		const css = generateProseCss(makeTheme());
		expect(css).toContain('blockquote');
	});

	it('contains styles for all six heading levels', () => {
		const css = generateProseCss(makeTheme());
		for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
			expect(css).toMatch(new RegExp(`\\.markdown-fast-block ${tag}\\s*\\{`));
		}
	});

	it('contains styles for list checkbox special-case', () => {
		const css = generateProseCss(makeTheme());
		// `:has(> input[type="checkbox"])` selector for task lists
		expect(css).toContain('input[type="checkbox"]');
	});
});
