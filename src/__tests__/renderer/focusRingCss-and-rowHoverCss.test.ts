// Source: src/__tests__/renderer/focusRingCss.test.ts
// Source: src/__tests__/renderer/rowHoverCss.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { readdirSync } from 'fs';
import { statSync } from 'fs';
describeSourceSuite('focusRingCss', () => {
	// Line endings are normalized on the way in: with no `.gitattributes` pinning
	// `eol`, a Windows checkout carries CRLF, and the multi-line selector lookup
	// below searches for a literal `\n`. Without this the block reads as empty and
	// the test asserts against '' rather than against the rule.
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
});
describeSourceSuite('rowHoverCss', () => {
	const rendererDir = path.join(__dirname, '../..', 'renderer');
	const css = readFileSync(path.join(rendererDir, 'index.css'), 'utf-8');

	/** The declaration block following a given selector, as raw text. */
	const blockFor = (selector: string): string => {
		const start = css.indexOf(`${selector} {`);
		if (start === -1) return '';
		return css.slice(start, css.indexOf('}', start));
	};

	/** Every `.ts` / `.tsx` file under `src/renderer`. */
	const collectSources = (dir: string, out: string[] = []): string[] => {
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) {
				collectSources(full, out);
			} else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
				out.push(full);
			}
		}
		return out;
	};

	describe('row hover CSS', () => {
		it('defines the wash and its light-mode inversion', () => {
			// The theme publishes `--bg-hover-wash`, so a theme that names its own
			// hover wins; the literal stays as the fallback for a theme that does not.
			expect(blockFor('.row-hover')).toContain(
				'--row-hover-wash: var(--bg-hover-wash, rgb(255 255 255 / 0.06))'
			);
			expect(blockFor("html[data-theme-mode='light'] .row-hover")).toContain(
				'--row-hover-wash: var(--bg-hover-wash, rgb(0 0 0 / 0.05))'
			);
		});

		it('paints the wash with background-image so an inline background-color survives', () => {
			const block = blockFor('.row-hover:hover');
			// A `background-color` rule would lose to the inline declaration that
			// marks a row active / keyboard-selected / drag-over. A gradient is a
			// separate layer and composites on top of it, so a selected row keeps
			// reading as selected while it brightens under the cursor.
			expect(block).toContain('background-image: linear-gradient(');
			expect(block).toContain('var(--row-hover-wash)');
			expect(block).not.toContain('background-color');
		});
	});

	describe('dead Tailwind hover classes', () => {
		it('no renderer source pairs hover:bg-opacity-* with an inline background', () => {
			const offenders = collectSources(rendererDir).filter((file) =>
				/hover:bg-opacity-/.test(readFileSync(file, 'utf-8'))
			);
			expect(offenders).toEqual([]);
		});
	});
});
