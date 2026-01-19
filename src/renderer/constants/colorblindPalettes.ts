/**
 * Colorblind-Friendly Color Palettes
 *
 * Provides accessible color palettes for users with color vision deficiencies.
 * Based on research from:
 * - Wong, B. (2011). "Points of view: Color blindness". Nature Methods
 * - IBM Design for Color Blindness guidelines
 * - Okabe & Ito colorblind-safe palette
 *
 * Features:
 * - Works for all major types of color blindness (protanopia, deuteranopia, tritanopia)
 * - High contrast between adjacent colors
 * - Distinguishable in grayscale
 * - Tested with color blindness simulators
 */

/**
 * Colorblind-safe palette types
 */
export type ColorBlindMode = 'none' | 'enabled';

/**
 * Wong's colorblind-safe palette (Nature Methods, 2011)
 * Optimized for protanopia, deuteranopia, and tritanopia
 * Uses distinct luminance values for additional differentiation
 */
export const COLORBLIND_AGENT_PALETTE = [
	'#0077BB', // Strong Blue - high contrast, visible to all
	'#EE7733', // Orange - distinct from blue, visible to protanopes
	'#009988', // Teal - distinct from both, visible to deuteranopes
	'#CC3311', // Vermillion/Red - distinct hue and brightness
	'#33BBEE', // Cyan/Sky Blue - lighter blue, high luminance
	'#EE3377', // Magenta/Pink - distinct from all above
	'#BBBBBB', // Gray - neutral, distinguishable by luminance
	'#000000', // Black - maximum contrast fallback
	'#AA4499', // Purple - additional distinct hue
	'#44AA99', // Blue-Green - additional distinct hue
];

/**
 * Two-color palette for binary comparisons (e.g., Interactive vs Auto)
 * Uses maximum perceptual difference for all color vision types
 */
export const COLORBLIND_BINARY_PALETTE = {
	primary: '#0077BB', // Strong Blue - consistent with agent palette
	secondary: '#EE7733', // Orange - maximum contrast with blue
};

/**
 * Heatmap color scale for colorblind users
 * Uses a sequential palette from light to dark with distinct hue shifts
 * Based on viridis-like perceptually uniform color scale
 */
export const COLORBLIND_HEATMAP_SCALE = [
	'#FFFFCC', // Level 0: Very light yellow (no activity)
	'#C7E9B4', // Level 1: Light green
	'#41B6C4', // Level 2: Teal/Cyan
	'#2C7FB8', // Level 3: Blue
	'#253494', // Level 4: Dark Blue (high activity)
];

/**
 * Get a color from the colorblind agent palette by index
 */
export function getColorBlindAgentColor(index: number): string {
	return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
}

/**
 * Get the appropriate heatmap color for a given intensity level (0-4)
 */
export function getColorBlindHeatmapColor(intensity: number): string {
	const clampedIntensity = Math.max(0, Math.min(4, Math.round(intensity)));
	return COLORBLIND_HEATMAP_SCALE[clampedIntensity];
}

/**
 * Line chart colors for colorblind mode
 * Uses high-contrast colors that are distinguishable in all color blindness types
 */
export const COLORBLIND_LINE_COLORS = {
	primary: '#0077BB', // Strong Blue
	secondary: '#EE7733', // Orange
	tertiary: '#009988', // Teal
};

/**
 * Helper to determine if colorblind mode should use pattern fills
 * in addition to colors for maximum accessibility
 */
export const COLORBLIND_PATTERNS = {
	solid: 'solid',
	diagonal: 'diagonal-stripes',
	dots: 'dots',
	crosshatch: 'crosshatch',
	horizontal: 'horizontal-stripes',
	vertical: 'vertical-stripes',
} as const;

export type ColorBlindPattern = keyof typeof COLORBLIND_PATTERNS;

/**
 * Get pattern for additional visual distinction in colorblind mode
 * Can be used as SVG pattern fill for enhanced accessibility
 */
export function getColorBlindPattern(index: number): ColorBlindPattern {
	const patterns: ColorBlindPattern[] = [
		'solid',
		'diagonal',
		'dots',
		'crosshatch',
		'horizontal',
		'vertical',
	];
	return patterns[index % patterns.length];
}
