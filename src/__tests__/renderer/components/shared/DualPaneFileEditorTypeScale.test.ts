import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The shared editor's chrome is styled by a plain stylesheet, so these are
 * assertions about that file rather than about a render: jsdom applies no
 * stylesheet, and the values are only meaningful as CSS.
 *
 * The bug: every size here was a px literal chosen when the app root was always
 * 14px monospace. The root is the interface font size now, so neighbouring
 * surfaces grew with it (and with Cmd+=) while this panel stayed frozen and
 * read small beside the Settings chrome around it.
 */
const CSS = readFileSync(
	path.join(__dirname, '../../../../renderer/components/shared/DualPaneFileEditor.css'),
	'utf8'
);

describe('DualPaneFileEditor type scale', () => {
	it('declares no font-size in px', () => {
		// A px size cannot scale with the root or with zoom, which is the whole
		// defect. Catching it here stops the next edit from reintroducing one.
		const pxSizes = CSS.match(/font-size:\s*[\d.]+px/g) ?? [];
		expect(pxSizes).toEqual([]);
	});

	it('sizes every rule in rem', () => {
		const sizes = CSS.match(/font-size:\s*[^;]+;/g) ?? [];
		expect(sizes.length).toBeGreaterThan(8);
		for (const size of sizes) {
			expect(size).toMatch(/font-size:\s*[\d.]+rem;/);
		}
	});

	it('keeps the list and editor within a few percent of their old size on the monospace preset', () => {
		// Existing users on the 14px baseline should not see this panel jump.
		const remOf = (selector: string): number => {
			const block = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(CSS)?.[0] ?? '';
			return Number(/font-size:\s*([\d.]+)rem/.exec(block)?.[1] ?? 0);
		};

		for (const [selector, oldPx] of [
			['.dual-pane-list-item', 12],
			['.dual-pane-textarea', 12],
			['.dual-pane-category-header', 11],
			['.dual-pane-no-selection', 13],
		] as const) {
			const renderedAtBaseline = remOf(selector) * 14;
			expect(renderedAtBaseline).toBeGreaterThan(0);
			expect(Math.abs(renderedAtBaseline - oldPx) / oldPx).toBeLessThan(0.06);
		}
	});

	it('points the textarea at the File Editor font, with a literal fallback', () => {
		// Editing a prompt or a memory file IS file editing, so it follows that
		// surface like every other editor. The fallback covers the first paint,
		// before the renderer publishes the variable.
		expect(CSS).toContain('var(--maestro-font-file-editor,');
		expect(CSS).toMatch(/var\(--maestro-font-file-editor,[^)]*monospace\)/);
	});

	it('no longer hard-codes a monospace family', () => {
		const families = CSS.match(/font-family:\s*[^;]+;/g) ?? [];
		for (const family of families) {
			expect(family).toContain('var(--maestro-font');
		}
	});
});
