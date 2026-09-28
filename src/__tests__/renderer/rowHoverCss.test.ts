/**
 * @file rowHoverCss.test.ts
 * @description Guards the `.row-hover` rule in `src/renderer/index.css` and,
 * more importantly, guards against the dead Tailwind class it replaced.
 *
 * `hover:bg-opacity-*` only edits the alpha channel of a `bg-{color}` utility.
 * Forty-two elements in the renderer paired it with an INLINE background style
 * instead, so the class resolved to nothing and those controls (every Left Bar
 * agent row, every group header, most Process Monitor and Log Viewer icon
 * buttons) had no hover feedback at all. jsdom applies no stylesheet, so no
 * component test could ever have noticed. Both halves are checked off disk.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

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
