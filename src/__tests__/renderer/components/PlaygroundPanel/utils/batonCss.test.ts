import { describe, expect, it } from 'vitest';
import {
	BATON_DEFAULTS,
	BATON_GLINT_COUNT,
	buildBatonAnimationCss,
	buildBatonCopyCss,
	getBatonStaggerDelays,
} from '../../../../../renderer/components/PlaygroundPanel/utils/batonCss';

describe('PlaygroundPanel baton CSS helpers', () => {
	it('calculates a stagger delay per glint from the configured offset', () => {
		expect(getBatonStaggerDelays(0.8)).toEqual(['0.00', '0.80', '1.60']);
		expect(getBatonStaggerDelays(0)).toEqual(['0.00', '0.00', '0.00']);
	});

	it('emits one delay per glint the preview renders', () => {
		expect(getBatonStaggerDelays(BATON_DEFAULTS.staggerOffset)).toHaveLength(BATON_GLINT_COUNT);
	});

	it('builds injected playground animation CSS with defaults', () => {
		const css = buildBatonAnimationCss(BATON_DEFAULTS);

		expect(css).toContain('@keyframes playground-wand-glint');
		expect(css).toContain('.baton-glint {');
		expect(css).toContain('animation: playground-wand-glint 2.4s ease-in-out infinite');
		expect(css).toContain('transform: translate(0.5px, -0.5px) scale(1)');
		expect(css).toContain('@media (prefers-reduced-motion: reduce)');
	});

	it('builds injected CSS with changed timing, movement, and easing', () => {
		const css = buildBatonAnimationCss({
			duration: 6.5,
			peakAt: 20,
			settleAt: 80,
			translateAmount: 2,
			staggerOffset: 1,
			easing: 'linear',
		});

		expect(css).toContain('20%');
		expect(css).toContain('80%');
		expect(css).toContain('translate(2px, -2px)');
		expect(css).toContain('animation: playground-wand-glint 6.5s linear infinite');
		expect(css).toContain('.baton-glint-3 { animation-delay: 2.00s; }');
	});

	it('builds copy CSS for production wand classes', () => {
		const css = buildBatonCopyCss(BATON_DEFAULTS);

		expect(css).toContain('@keyframes wand-glint');
		expect(css).toContain('.wand-glint {');
		expect(css).toContain('animation: wand-glint 2.4s ease-in-out infinite');
		expect(css).toContain('prefers-reduced-motion');
		expect(css).not.toContain('playground-wand-glint');
		expect(css).not.toContain('baton-glint');
	});

	// The panel's entire purpose is producing CSS you paste into index.css. If it
	// emits the pattern the wand was moved OFF, copying it silently reintroduces
	// ~27,000 main-thread style invalidations per minute - the regression this
	// whole animation was rebuilt to escape.
	it('never emits the uncompositable SVG-path pattern', () => {
		for (const css of [buildBatonAnimationCss(BATON_DEFAULTS), buildBatonCopyCss(BATON_DEFAULTS)]) {
			expect(css).not.toContain('path:nth-child');
		}
	});

	it('defaults match the shipped animation so Reset gives you the real wand', () => {
		expect(BATON_DEFAULTS.duration).toBe(2.4);
		expect(getBatonStaggerDelays(BATON_DEFAULTS.staggerOffset)).toEqual(['0.00', '0.80', '1.60']);
	});
});
