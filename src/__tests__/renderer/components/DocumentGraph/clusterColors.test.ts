/**
 * Tests for the Lobes layout's cluster colours (clusterColors.ts).
 *
 * The colours are derived from the active theme's accent by hue rotation
 * rather than taken from a fixed palette, so the properties worth pinning are
 * about the derivation: that the first cluster is the theme's own colour, that
 * successive clusters are actually distinguishable, and that a near-grey
 * accent does not collapse every lobe into the same grey.
 */

import { describe, it, expect } from 'vitest';
import {
	clusterColor,
	clusterHullStyle,
} from '../../../../renderer/components/DocumentGraph/clusterColors';

/** Parse an `rgb(r, g, b)` string back into channels. */
function channels(color: string): { r: number; g: number; b: number } {
	const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (!match) throw new Error(`not an rgb colour: ${color}`);
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function distance(a: string, b: string): number {
	const ca = channels(a);
	const cb = channels(b);
	return Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b);
}

const ACCENT = '#9146FF';

describe('clusterColors', () => {
	describe('clusterColor', () => {
		it('gives the first cluster the theme accent itself', () => {
			// The dominant lobe holds the center document. Painting it the
			// theme's own colour is what stops the graph looking like it picked
			// an arbitrary palette out of nowhere.
			const accentChannels = channels('rgb(145, 70, 255)');
			const first = channels(clusterColor(ACCENT, 0));
			expect(Math.abs(first.r - accentChannels.r)).toBeLessThanOrEqual(2);
			expect(Math.abs(first.g - accentChannels.g)).toBeLessThanOrEqual(2);
			expect(Math.abs(first.b - accentChannels.b)).toBeLessThanOrEqual(2);
		});

		it('separates the first several clusters clearly', () => {
			// These are the lobes with enough nodes to matter. An even 360/n
			// split cannot guarantee this without knowing n up front, which is
			// why the rotation is a golden-angle walk.
			const colors = [0, 1, 2, 3, 4].map((i) => clusterColor(ACCENT, i));
			for (let i = 0; i < colors.length; i++) {
				for (let j = i + 1; j < colors.length; j++) {
					expect(distance(colors[i], colors[j])).toBeGreaterThan(40);
				}
			}
		});

		it('is deterministic', () => {
			expect(clusterColor(ACCENT, 3)).toBe(clusterColor(ACCENT, 3));
		});

		it('still separates lobes on a near-grey accent', () => {
			// Rotating the hue of a grey produces another grey, so the
			// saturation is floored. Without that, a monochrome theme paints
			// every lobe the same colour and the grouping disappears.
			const grey = '#808080';
			const a = clusterColor(grey, 0);
			const b = clusterColor(grey, 1);
			expect(distance(a, b)).toBeGreaterThan(40);
		});

		it('returns the input unchanged when the accent is not parseable', () => {
			expect(clusterColor('not-a-colour', 2)).toBe('not-a-colour');
		});

		it('produces channels in range for a long walk around the wheel', () => {
			for (let i = 0; i < 30; i++) {
				const { r, g, b } = channels(clusterColor(ACCENT, i));
				[r, g, b].forEach((channel) => {
					expect(channel).toBeGreaterThanOrEqual(0);
					expect(channel).toBeLessThanOrEqual(255);
				});
			}
		});
	});

	describe('clusterHullStyle', () => {
		it('draws the hull as a background wash, not a solid', () => {
			// The nodes are the content; a hull opaque enough to compete with
			// them makes the graph harder to read, not easier.
			const { fill, stroke } = clusterHullStyle(ACCENT, 0, false);
			const fillAlpha = Number(fill.match(/,\s*([\d.]+)\)$/)![1]);
			const strokeAlpha = Number(stroke.match(/,\s*([\d.]+)\)$/)![1]);
			expect(fillAlpha).toBeLessThan(0.2);
			expect(strokeAlpha).toBeGreaterThan(fillAlpha);
			expect(strokeAlpha).toBeLessThan(1);
		});

		it('mutes the ungrouped pile below every real cluster', () => {
			const real = clusterHullStyle(ACCENT, 1, false);
			const ungrouped = clusterHullStyle(ACCENT, 1, true);
			const alpha = (color: string) => Number(color.match(/,\s*([\d.]+)\)$/)![1]);
			expect(alpha(ungrouped.fill)).toBeLessThan(alpha(real.fill));
			expect(alpha(ungrouped.stroke)).toBeLessThan(alpha(real.stroke));
		});

		it('denies the ungrouped pile a hue of its own', () => {
			// It is the leftovers, not a finding. Giving it a colour would
			// present "these belong to nothing" as just another group.
			const ungrouped = clusterHullStyle(ACCENT, 3, true);
			const accentish = clusterHullStyle(ACCENT, 0, true);
			expect(channels(ungrouped.fill)).toEqual(channels(accentish.fill));
		});
	});
});
