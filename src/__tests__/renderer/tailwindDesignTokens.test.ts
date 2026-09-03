/**
 * Tailwind design-token aliases.
 *
 * The app had drifted onto five corner-radius tiers and four transition
 * durations, most of them a copy-paste accident rather than a decision. Rather
 * than rewrite ~130 call sites, the config aliases the stray tiers onto the two
 * the design language actually uses, so `rounded-md` renders as `rounded` and
 * `duration-200` renders at the 150ms default with zero component edits.
 *
 * These assertions exist because the aliases are invisible at the call site: a
 * future edit to the config could restore Tailwind's defaults and every
 * `rounded-md` in the app would silently go back to 6px with nothing in the
 * diff to say so.
 */

import { describe, it, expect } from 'vitest';
import tailwindConfig from '../../../tailwind.config.mjs';

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
