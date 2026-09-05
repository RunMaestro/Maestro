/**
 * @file focusRingCss.test.ts
 * @description Guards the `.focus-ring` / `.focus-ring-inset` rules in
 * `src/renderer/index.css`.
 *
 * These classes are pure CSS, so jsdom never applies them and no component
 * test can see whether they resolve to anything at all. That is exactly how
 * they went missing: sixteen call sites across ScaleControl, Slider,
 * RankedChoice, ChartErrorBoundary, AIOverviewTab and NarrativeParseError
 * carried `className="focus-ring"` while the class was defined nowhere, so
 * every one of those controls was invisible to a keyboard user and every
 * component test still passed. The rules are read straight off disk instead.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// A Windows checkout with autocrlf hands back `\r\n` line endings, and the
// selector lookups below are written with `\n`, so normalize first.
const css = readFileSync(path.join(__dirname, '../..', 'renderer', 'index.css'), 'utf-8').replace(
	/\r\n/g,
	'\n'
);

/** Every selector line that mentions a focus ring class. */
const focusRingSelectors = css
	.split('\n')
	.map((line) => line.trim())
	.filter((line) => line.startsWith('.focus-ring'));

/** The declaration block following a given selector, as raw text. */
const blockFor = (selector: string): string => {
	const start = css.indexOf(`${selector} {`);
	if (start === -1) return '';
	return css.slice(start, css.indexOf('}', start));
};

describe('focus ring CSS', () => {
	it('defines both classes the components already reference', () => {
		expect(focusRingSelectors).toContain('.focus-ring:focus-visible {');
		expect(focusRingSelectors).toContain('.focus-ring-inset:focus-visible {');
	});

	it('suppresses the default outline on plain :focus, so a mouse click stays quiet', () => {
		expect(blockFor('.focus-ring:focus,\n.focus-ring-inset:focus')).toContain('outline: none');
	});

	for (const selector of ['.focus-ring:focus-visible', '.focus-ring-inset:focus-visible']) {
		it(`${selector} paints an accent ring honoring --focus-ring-color`, () => {
			const block = blockFor(selector);
			// AIOverviewTab sets --focus-ring-color inline for a higher-contrast
			// ring on a filled segment, so the override has to come first and the
			// theme accent has to be the fallback.
			expect(block).toContain('var(--focus-ring-color, var(--accent-color');
			expect(block).toMatch(/outline: 2px solid/);
		});
	}

	it('offsets the normal ring outward and the inset ring inward', () => {
		expect(blockFor('.focus-ring:focus-visible')).toContain('outline-offset: 2px');
		expect(blockFor('.focus-ring-inset:focus-visible')).toContain('outline-offset: -2px');
	});
});
