import { describe, it, expect } from 'vitest';
import {
	computeTypographyVars,
	type TypographyVarInput,
} from '../../../renderer/utils/applyTypographyVars';
import { MONO_ACCENT_VAR, TYPOGRAPHY_SURFACE_SPECS } from '../../../shared/typography';

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
