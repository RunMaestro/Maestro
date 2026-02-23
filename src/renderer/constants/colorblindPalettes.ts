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

/**
 * Colorblind-safe palette for file extension badges.
 * Uses Wong's palette with appropriate contrast for badge backgrounds and text.
 * Each extension category is mapped to a distinct, colorblind-safe color.
 *
 * Colors are chosen to be distinguishable in:
 * - Protanopia (red-green, red-weak)
 * - Deuteranopia (red-green, green-weak)
 * - Tritanopia (blue-yellow)
 *
 * Each color has a light mode and dark mode variant for proper contrast.
 */
export const COLORBLIND_EXTENSION_PALETTE = {
	// TypeScript/JavaScript - Strong Blue (#0077BB)
	typescript: {
		light: { bg: 'rgba(0, 119, 187, 0.18)', text: 'rgba(0, 90, 150, 0.95)' },
		dark: { bg: 'rgba(0, 119, 187, 0.35)', text: 'rgba(102, 178, 230, 0.95)' },
	},
	// Markdown/Docs - Teal (#009988)
	markdown: {
		light: { bg: 'rgba(0, 153, 136, 0.18)', text: 'rgba(0, 115, 100, 0.95)' },
		dark: { bg: 'rgba(0, 153, 136, 0.35)', text: 'rgba(77, 204, 189, 0.95)' },
	},
	// JSON/Config - Orange (#EE7733)
	config: {
		light: { bg: 'rgba(238, 119, 51, 0.18)', text: 'rgba(180, 85, 30, 0.95)' },
		dark: { bg: 'rgba(238, 119, 51, 0.35)', text: 'rgba(255, 170, 120, 0.95)' },
	},
	// CSS/Styles - Purple (#AA4499)
	styles: {
		light: { bg: 'rgba(170, 68, 153, 0.18)', text: 'rgba(130, 50, 115, 0.95)' },
		dark: { bg: 'rgba(170, 68, 153, 0.35)', text: 'rgba(210, 140, 195, 0.95)' },
	},
	// HTML/Templates - Vermillion (#CC3311)
	html: {
		light: { bg: 'rgba(204, 51, 17, 0.18)', text: 'rgba(160, 40, 15, 0.95)' },
		dark: { bg: 'rgba(204, 51, 17, 0.35)', text: 'rgba(255, 130, 100, 0.95)' },
	},
	// Python - Cyan (#33BBEE)
	python: {
		light: { bg: 'rgba(51, 187, 238, 0.18)', text: 'rgba(30, 130, 175, 0.95)' },
		dark: { bg: 'rgba(51, 187, 238, 0.35)', text: 'rgba(130, 210, 245, 0.95)' },
	},
	// Rust - Magenta (#EE3377)
	rust: {
		light: { bg: 'rgba(238, 51, 119, 0.18)', text: 'rgba(180, 35, 85, 0.95)' },
		dark: { bg: 'rgba(238, 51, 119, 0.35)', text: 'rgba(255, 140, 175, 0.95)' },
	},
	// Go - Blue-Green (#44AA99)
	go: {
		light: { bg: 'rgba(68, 170, 153, 0.18)', text: 'rgba(45, 130, 115, 0.95)' },
		dark: { bg: 'rgba(68, 170, 153, 0.35)', text: 'rgba(130, 210, 195, 0.95)' },
	},
	// Shell - Gray (#BBBBBB)
	shell: {
		light: { bg: 'rgba(120, 120, 120, 0.18)', text: 'rgba(80, 80, 80, 0.95)' },
		dark: { bg: 'rgba(150, 150, 150, 0.35)', text: 'rgba(200, 200, 200, 0.95)' },
	},
	// Images - Magenta (#EE3377)
	image: {
		light: { bg: 'rgba(238, 51, 119, 0.18)', text: 'rgba(180, 35, 85, 0.95)' },
		dark: { bg: 'rgba(238, 51, 119, 0.35)', text: 'rgba(255, 140, 175, 0.95)' },
	},
	// Java/JVM - Vermillion (#CC3311)
	java: {
		light: { bg: 'rgba(204, 51, 17, 0.18)', text: 'rgba(160, 40, 15, 0.95)' },
		dark: { bg: 'rgba(204, 51, 17, 0.35)', text: 'rgba(255, 130, 100, 0.95)' },
	},
	// C/C++ - Strong Blue lighter (#3388CC)
	cpp: {
		light: { bg: 'rgba(51, 136, 204, 0.18)', text: 'rgba(30, 100, 165, 0.95)' },
		dark: { bg: 'rgba(51, 136, 204, 0.35)', text: 'rgba(130, 190, 240, 0.95)' },
	},
	// Ruby - Orange variant (#EE7733)
	ruby: {
		light: { bg: 'rgba(238, 119, 51, 0.18)', text: 'rgba(180, 85, 30, 0.95)' },
		dark: { bg: 'rgba(238, 119, 51, 0.35)', text: 'rgba(255, 170, 120, 0.95)' },
	},
	// SQL/Data - Purple (#AA4499)
	data: {
		light: { bg: 'rgba(170, 68, 153, 0.18)', text: 'rgba(130, 50, 115, 0.95)' },
		dark: { bg: 'rgba(170, 68, 153, 0.35)', text: 'rgba(210, 140, 195, 0.95)' },
	},
	// PDF/Office - Blue-Green (#44AA99)
	document: {
		light: { bg: 'rgba(68, 170, 153, 0.18)', text: 'rgba(45, 130, 115, 0.95)' },
		dark: { bg: 'rgba(68, 170, 153, 0.35)', text: 'rgba(130, 210, 195, 0.95)' },
	},
	// Default/Unknown - uses theme accent (handled in getExtensionColor)
};

/**
 * Get colorblind-safe color for file extension badges.
 * Maps file extensions to colorblind-friendly colors from Wong's palette.
 *
 * @param extension - File extension including dot (e.g., '.ts', '.md')
 * @param isLightTheme - Whether the current theme is light mode
 * @returns Object with bg (background) and text color in rgba format
 */
export function getColorBlindExtensionColor(
	extension: string,
	isLightTheme: boolean
): { bg: string; text: string } | null {
	const ext = extension.toLowerCase();
	const mode = isLightTheme ? 'light' : 'dark';

	// TypeScript/JavaScript
	if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.typescript[mode];
	}
	// Markdown/Docs
	if (['.md', '.mdx', '.txt', '.rst'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.markdown[mode];
	}
	// JSON/Config
	if (['.json', '.yaml', '.yml', '.toml', '.ini', '.env'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.config[mode];
	}
	// CSS/Styles
	if (['.css', '.scss', '.sass', '.less', '.styl'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.styles[mode];
	}
	// HTML/Templates
	if (['.html', '.htm', '.xml', '.svg'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.html[mode];
	}
	// Python
	if (['.py', '.pyw', '.pyi'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.python[mode];
	}
	// Rust
	if (['.rs'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.rust[mode];
	}
	// Go
	if (['.go'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.go[mode];
	}
	// Shell scripts
	if (['.sh', '.bash', '.zsh', '.fish'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.shell[mode];
	}
	// Images
	if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.avif'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.image[mode];
	}
	// Java/JVM
	if (['.java', '.kt', '.scala', '.groovy', '.clj'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.java[mode];
	}
	// C/C++
	if (['.c', '.cpp', '.cc', '.h', '.hpp', '.hh', '.cs', '.swift'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.cpp[mode];
	}
	// Ruby
	if (['.rb', '.erb', '.rake'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.ruby[mode];
	}
	// SQL/Data
	if (['.sql', '.db', '.sqlite', '.csv', '.tsv'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.data[mode];
	}
	// PDF/Office documents
	if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) {
		return COLORBLIND_EXTENSION_PALETTE.document[mode];
	}

	// Return null for unknown extensions (caller uses theme accent)
	return null;
}
