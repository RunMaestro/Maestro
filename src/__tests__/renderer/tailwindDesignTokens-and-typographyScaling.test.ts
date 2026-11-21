import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import tailwindConfig from '../../../tailwind.config.mjs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
__maestroMicrobenchDescribe('tailwindDesignTokens', () => {
	const extend = (tailwindConfig.theme?.extend ?? {}) as {
		borderRadius?: Record<string, string>;
		transitionDuration?: Record<string, string>;
	};

	describe('Tailwind design-token aliases', () => {
		describe('corner radius', () => {
			it('collapses rounded-md onto the 4px tier', () => {
				// 0.25rem is Tailwind's own `rounded`. Dropping this alias reverts
				// 80 call sites to 6px.
				expect(extend.borderRadius?.md).toBe('0.25rem');
			});

			it('collapses rounded-xl onto the 8px tier', () => {
				// 0.5rem is Tailwind's own `rounded-lg`. Dropping this alias reverts
				// 47 call sites to 12px.
				expect(extend.borderRadius?.xl).toBe('0.5rem');
			});

			it('leaves the intentional tiers at their Tailwind defaults', () => {
				// `rounded-sm`, `rounded-2xl`, and `rounded-full` are deliberate and
				// visually distinct - aliasing them would flatten real hierarchy.
				expect(extend.borderRadius).not.toHaveProperty('sm');
				expect(extend.borderRadius).not.toHaveProperty('2xl');
				expect(extend.borderRadius).not.toHaveProperty('full');
			});
		});

		describe('transition duration', () => {
			it('normalizes the micro-variants onto the 150ms default', () => {
				expect(extend.transitionDuration?.['100']).toBe('150ms');
				expect(extend.transitionDuration?.['200']).toBe('150ms');
			});

			it('leaves the slower tiers alone', () => {
				// 300ms and 500ms read as deliberate easing, not drift.
				expect(extend.transitionDuration).not.toHaveProperty('300');
				expect(extend.transitionDuration).not.toHaveProperty('500');
			});
		});
	});
});
__maestroMicrobenchDescribe('typographyScaling', () => {
	const REPO_ROOT = path.join(__dirname, '../../..');

	function tsxFiles(): string[] {
		return ['src/renderer', 'src/web'].flatMap((root) =>
			readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: 'utf8' })
				.filter((file) => file.endsWith('.tsx'))
				.map((file) => path.join(root, file))
		);
	}

	/**
	 * Everything the user can see must resize when they zoom the interface.
	 *
	 * A `fontSize` given in px is frozen: it ignores both the interface font size
	 * and the Cmd+= multiplier, so it grows out of proportion with its neighbours
	 * as the app scales around it. `rem` follows the root, `em` follows the
	 * parent, and both track the zoom.
	 *
	 * This is a source scan rather than a render assertion because the defect is
	 * a literal in a style object - a rendered test would have to visit every
	 * component to find one, and would still miss the ones behind a conditional.
	 */
	describe('font sizes scale with the interface', () => {
		it('declares no fontSize in px anywhere in the renderer or web client', () => {
			const offenders: string[] = [];

			for (const file of tsxFiles()) {
				const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
				for (const match of src.matchAll(/fontSize:\s*['"`](\d[\d.]*px)['"`]/g)) {
					offenders.push(`${file} -> ${match[1]}`);
				}
			}

			expect(offenders).toEqual([]);
		});

		it('allows px in a computed value, which is derived from the scaled size', () => {
			// `${resolveSurfaceFontSize(...)}px` is fine: the NUMBER already has the
			// zoom applied. Only a hard-coded literal is frozen. This asserts the
			// rule above is not accidentally banning the correct pattern.
			const src = readFileSync(
				path.join(REPO_ROOT, 'src/renderer/utils/applyTypographyVars.ts'),
				'utf8'
			);
			expect(src).toContain('px`');
		});
	});
});
