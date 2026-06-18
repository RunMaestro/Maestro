import { describe, expect, it } from 'vitest';
import {
	BATON_DEFAULTS,
	buildBatonAnimationCss,
	buildBatonCopyCss,
	getBatonStaggerDelays,
} from '../../../../../renderer/components/PlaygroundPanel/utils/batonCss';

describe('PlaygroundPanel baton CSS helpers', () => {
	it('calculates stagger delays from the configured offset', () => {
		expect(getBatonStaggerDelays(0.5)).toEqual(['0.00', '0.50', '1.00', '1.50', '0.70', '1.20']);
		expect(getBatonStaggerDelays(0)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
	});

	it('builds injected playground animation CSS with defaults', () => {
		const css = buildBatonAnimationCss(BATON_DEFAULTS);

		expect(css).toContain('@keyframes playground-wand-sparkle');
		expect(css).toContain('svg.baton-sparkle-active path:nth-child(n+3)');
		expect(css).toContain('animation: playground-wand-sparkle 3s ease-in-out infinite');
		expect(css).toContain('transform: translate(0.5px, -0.5px)');
		expect(css).toContain('@media (prefers-reduced-motion: reduce)');
	});

	it('builds injected CSS with changed timing, movement, and easing', () => {
		const css = buildBatonAnimationCss({
			duration: 6.5,
			fadeOutStart: 20,
			fadeInStart: 80,
			translateAmount: 2,
			staggerOffset: 1,
			easing: 'linear',
		});

		expect(css).toContain('20%');
		expect(css).toContain('80%');
		expect(css).toContain('translate(2px, -2px)');
		expect(css).toContain('animation: playground-wand-sparkle 6.5s linear infinite');
		expect(css).toContain('animation-delay: 2.40s');
	});

	it('builds copy CSS for production wand classes', () => {
		const css = buildBatonCopyCss(BATON_DEFAULTS);

		expect(css).toContain('@keyframes wand-sparkle');
		expect(css).toContain('svg.wand-sparkle-active path:nth-child(n+3)');
		expect(css).toContain('animation: wand-sparkle 3s ease-in-out infinite');
		expect(css).toContain('prefers-reduced-motion');
		expect(css).not.toContain('playground-wand-sparkle');
	});
});
