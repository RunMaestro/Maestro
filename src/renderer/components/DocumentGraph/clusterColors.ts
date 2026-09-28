/**
 * Colours for the Lobes layout's clusters.
 *
 * Derived from the theme's own accent by rotating its hue rather than picked
 * from a fixed palette, so a lobe never lands on a colour the active theme
 * does not use. A hard-coded set looks wrong on half the themes and, worse,
 * can land on the theme's error or warning colour, which reads as a status the
 * graph is not reporting.
 *
 * The rotation is deliberately uneven (a golden-angle walk rather than an even
 * split) so the first few clusters - which are the ones with enough nodes to
 * matter - come out far apart on the wheel instead of as neighbouring shades.
 */

import { hexToRgb } from '../../../shared/colorContrast';

/**
 * Degrees between consecutive cluster hues. The golden angle keeps successive
 * values maximally separated no matter how many clusters there turn out to be,
 * which an even `360 / n` split cannot do without knowing `n` up front.
 */
const HUE_STEP_DEGREES = 137.50776405003785;

/** Fill and stroke alpha for a cluster hull. Low: it is a background wash. */
const HULL_FILL_ALPHA = 0.1;
const HULL_STROKE_ALPHA = 0.45;
/** The ungrouped pile is drawn fainter still - it is the leftovers. */
const UNGROUPED_FILL_ALPHA = 0.05;
const UNGROUPED_STROKE_ALPHA = 0.22;

interface Hsl {
	h: number;
	s: number;
	l: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;

	if (max === min) return { h: 0, s: 0, l };

	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
	else if (max === gn) h = ((bn - rn) / d + 2) / 6;
	else h = ((rn - gn) / d + 4) / 6;

	return { h: h * 360, s, l };
}

function hueToChannel(p: number, q: number, t: number): number {
	let tn = t;
	if (tn < 0) tn += 1;
	if (tn > 1) tn -= 1;
	if (tn < 1 / 6) return p + (q - p) * 6 * tn;
	if (tn < 1 / 2) return q;
	if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
	return p;
}

function hslToRgb({ h, s, l }: Hsl): { r: number; g: number; b: number } {
	if (s === 0) {
		const v = Math.round(l * 255);
		return { r: v, g: v, b: v };
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hn = (((h % 360) + 360) % 360) / 360;
	return {
		r: Math.round(hueToChannel(p, q, hn + 1 / 3) * 255),
		g: Math.round(hueToChannel(p, q, hn) * 255),
		b: Math.round(hueToChannel(p, q, hn - 1 / 3) * 255),
	};
}

/**
 * The base colour for cluster `index`, as `rgb(...)`.
 *
 * Index 0 returns the accent itself, so the dominant lobe - the one holding
 * the center document - is always the theme's own colour and the graph does
 * not appear to have picked an arbitrary palette.
 */
export function clusterColor(accent: string, index: number): string {
	const rgb = hexToRgb(accent);
	if (!rgb) return accent;

	const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
	// Floor the saturation so a near-grey accent still yields distinguishable
	// hues. Rotating the hue of a grey produces a different grey.
	const rotated = hslToRgb({
		h: hsl.h + index * HUE_STEP_DEGREES,
		s: Math.max(hsl.s, 0.45),
		l: hsl.l,
	});
	return `rgb(${rotated.r}, ${rotated.g}, ${rotated.b})`;
}

/** Fill and stroke for a cluster hull, already alpha-blended. */
export function clusterHullStyle(
	accent: string,
	index: number,
	ungrouped: boolean
): { fill: string; stroke: string } {
	const rgb = hexToRgb(accent);
	const base = ungrouped ? null : clusterColor(accent, index);

	// The ungrouped pile keeps the theme's neutral accent rather than taking a
	// hue of its own: it is not a finding, and giving it a colour would present
	// "these belong to nothing" as just another group.
	const color = base ?? (rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : accent);
	const fillAlpha = ungrouped ? UNGROUPED_FILL_ALPHA : HULL_FILL_ALPHA;
	const strokeAlpha = ungrouped ? UNGROUPED_STROKE_ALPHA : HULL_STROKE_ALPHA;

	return {
		fill: color.replace('rgb(', 'rgba(').replace(')', `, ${fillAlpha})`),
		stroke: color.replace('rgb(', 'rgba(').replace(')', `, ${strokeAlpha})`),
	};
}
