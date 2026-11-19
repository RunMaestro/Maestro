// Source: src/__tests__/renderer/components/shared/DualPaneFileEditorTypeScale.test.ts
// Source: src/__tests__/renderer/utils/applyTypographyVars.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { computeTypographyVars } from '../../../../renderer/utils/applyTypographyVars';
import type { TypographyVarInput } from '../../../../renderer/utils/applyTypographyVars';
import { MONO_ACCENT_VAR } from '../../../../shared/typography';
import { TYPOGRAPHY_SURFACE_SPECS } from '../../../../shared/typography';
describe('DualPaneFileEditorTypeScale', () => {
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
});
describe('applyTypographyVars', () => {
	function input(overrides: Partial<TypographyVarInput> = {}): TypographyVarInput {
		return {
			fonts: {
				interface: 'Inter',
				chat: '',
				terminal: '',
				filePreview: '',
				fileEditor: '',
			},
			sizes: { interface: 14, chat: 0, terminal: 0, filePreview: 0, fileEditor: 0 },
			baseSize: 14,
			zoom: 1,
			...overrides,
		};
	}

	describe('computeTypographyVars', () => {
		it('publishes a font and a size variable for every surface', () => {
			// These are what reach the 47 components that portal to document.body
			// and the ~200 font-mono sites - none of which can take a prop.
			const vars = computeTypographyVars(input());
			for (const spec of Object.values(TYPOGRAPHY_SURFACE_SPECS)) {
				expect(vars[spec.fontVar]).toBeTruthy();
				expect(vars[spec.sizeVar]).toMatch(/^[\d.]+px$/);
			}
		});

		it('resolves an unset surface to the interface font', () => {
			const vars = computeTypographyVars(input());
			expect(vars['--maestro-font-chat']).toContain('Inter');
			expect(vars['--maestro-font-file-preview']).toContain('Inter');
		});

		it('prefers a surface font over the interface font', () => {
			const vars = computeTypographyVars(
				input({
					fonts: {
						interface: 'Inter',
						chat: '',
						terminal: 'JetBrains Mono',
						filePreview: '',
						fileEditor: '',
					},
				})
			);
			expect(vars['--maestro-font-terminal']).toContain('JetBrains Mono');
			expect(vars['--maestro-font-terminal']).not.toContain('Inter');
		});

		it('always appends a generic family so nothing can fall through to serif', () => {
			const vars = computeTypographyVars(
				input({ fonts: { ...input().fonts, interface: 'Nonesuch' } })
			);
			for (const spec of Object.values(TYPOGRAPHY_SURFACE_SPECS)) {
				expect(vars[spec.fontVar]).toMatch(/\b(monospace|sans-serif|serif)\b/);
			}
		});

		describe('the code face', () => {
			it('follows the terminal font, the user\'s answer to "what is code"', () => {
				const vars = computeTypographyVars(
					input({
						fonts: { ...input().fonts, terminal: 'Fira Code' },
					})
				);
				expect(vars[MONO_ACCENT_VAR]).toContain('Fira Code');
			});

			it('falls back to the interface font when the terminal inherits', () => {
				const vars = computeTypographyVars(input());
				expect(vars[MONO_ACCENT_VAR]).toContain('Inter');
			});
		});

		describe('zoom', () => {
			it('scales every surface size by the same ratio', () => {
				const vars = computeTypographyVars(
					input({
						sizes: { interface: 16, chat: 0, terminal: 12, filePreview: 0, fileEditor: 0 },
						baseSize: 16,
						zoom: 1.5,
					})
				);
				expect(vars['--maestro-size-interface']).toBe('24px');
				expect(vars['--maestro-size-terminal']).toBe('18px');
			});

			it('drives --font-scale so fixed-width modals grow with the text', () => {
				// 14px is the baseline the .modal-w-* widths were drawn against.
				const vars = computeTypographyVars(input({ baseSize: 14, zoom: 2 }));
				expect(vars['--font-scale']).toBe('2');
			});

			it('leaves the surface sizes themselves untouched at 100%', () => {
				const vars = computeTypographyVars(
					input({ sizes: { ...input().sizes, terminal: 13 }, zoom: 1 })
				);
				expect(vars['--maestro-size-terminal']).toBe('13px');
			});
		});

		it('never lets the interface surface inherit, since it is the base', () => {
			// Its own size is used directly rather than resolved through itself,
			// which would be a cycle.
			const vars = computeTypographyVars(
				input({ baseSize: 18, sizes: { ...input().sizes, interface: 0 } })
			);
			expect(vars['--maestro-size-interface']).toBe('18px');
		});
	});
});
