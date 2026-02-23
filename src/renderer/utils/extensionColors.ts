/**
 * Shared file extension color utility.
 *
 * Single source of truth for file type badge colors used in TabBar and TabSwitcherModal.
 * Colors are adapted for both light and dark themes. When colorBlindMode is enabled,
 * delegates to Wong's colorblind-safe palette from colorblindPalettes.ts.
 */

import type { Theme } from '../types';
import { getColorBlindExtensionColor } from '../constants/colorblindPalettes';

/**
 * Parse a color string to extract RGB values.
 * Handles hex (#RRGGBB, #RGB) and returns components for rgba construction.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const match = hex.match(/^#([0-9a-f]{3,8})$/i);
	if (!match) return null;
	const h = match[1];
	if (h.length === 3) {
		return {
			r: parseInt(h[0] + h[0], 16),
			g: parseInt(h[1] + h[1], 16),
			b: parseInt(h[2] + h[2], 16),
		};
	}
	if (h.length >= 6) {
		return {
			r: parseInt(h.substring(0, 2), 16),
			g: parseInt(h.substring(2, 4), 16),
			b: parseInt(h.substring(4, 6), 16),
		};
	}
	return null;
}

/** Extension color categories with light and dark variants */
const EXTENSION_COLORS: Record<string, { light: { bg: string; text: string }; dark: { bg: string; text: string } }> = {
	// TypeScript/JavaScript - blue tones
	typescript: {
		light: { bg: 'rgba(37, 99, 235, 0.15)', text: 'rgba(29, 78, 216, 0.9)' },
		dark: { bg: 'rgba(59, 130, 246, 0.3)', text: 'rgba(147, 197, 253, 0.9)' },
	},
	// Markdown/Docs - green tones
	markdown: {
		light: { bg: 'rgba(22, 163, 74, 0.15)', text: 'rgba(21, 128, 61, 0.9)' },
		dark: { bg: 'rgba(34, 197, 94, 0.3)', text: 'rgba(134, 239, 172, 0.9)' },
	},
	// JSON/Config - yellow/amber tones
	config: {
		light: { bg: 'rgba(217, 119, 6, 0.15)', text: 'rgba(180, 83, 9, 0.9)' },
		dark: { bg: 'rgba(234, 179, 8, 0.3)', text: 'rgba(253, 224, 71, 0.9)' },
	},
	// CSS/Styles - purple tones
	styles: {
		light: { bg: 'rgba(147, 51, 234, 0.15)', text: 'rgba(126, 34, 206, 0.9)' },
		dark: { bg: 'rgba(168, 85, 247, 0.3)', text: 'rgba(216, 180, 254, 0.9)' },
	},
	// HTML/Templates - orange tones
	html: {
		light: { bg: 'rgba(234, 88, 12, 0.15)', text: 'rgba(194, 65, 12, 0.9)' },
		dark: { bg: 'rgba(249, 115, 22, 0.3)', text: 'rgba(253, 186, 116, 0.9)' },
	},
	// Python - teal/cyan tones
	python: {
		light: { bg: 'rgba(13, 148, 136, 0.15)', text: 'rgba(15, 118, 110, 0.9)' },
		dark: { bg: 'rgba(20, 184, 166, 0.3)', text: 'rgba(94, 234, 212, 0.9)' },
	},
	// Rust - rust/red tones
	rust: {
		light: { bg: 'rgba(185, 28, 28, 0.15)', text: 'rgba(153, 27, 27, 0.9)' },
		dark: { bg: 'rgba(239, 68, 68, 0.3)', text: 'rgba(252, 165, 165, 0.9)' },
	},
	// Go - cyan tones
	go: {
		light: { bg: 'rgba(8, 145, 178, 0.15)', text: 'rgba(14, 116, 144, 0.9)' },
		dark: { bg: 'rgba(6, 182, 212, 0.3)', text: 'rgba(103, 232, 249, 0.9)' },
	},
	// Shell scripts - gray/slate tones
	shell: {
		light: { bg: 'rgba(71, 85, 105, 0.15)', text: 'rgba(51, 65, 85, 0.9)' },
		dark: { bg: 'rgba(100, 116, 139, 0.3)', text: 'rgba(203, 213, 225, 0.9)' },
	},
	// Images - rose/pink tones
	image: {
		light: { bg: 'rgba(219, 39, 119, 0.15)', text: 'rgba(190, 24, 93, 0.9)' },
		dark: { bg: 'rgba(236, 72, 153, 0.3)', text: 'rgba(251, 182, 206, 0.9)' },
	},
	// Java/JVM - warm red-orange tones
	java: {
		light: { bg: 'rgba(220, 38, 38, 0.15)', text: 'rgba(185, 28, 28, 0.9)' },
		dark: { bg: 'rgba(248, 113, 113, 0.3)', text: 'rgba(254, 202, 202, 0.9)' },
	},
	// C/C++ - steel/slate blue tones
	cpp: {
		light: { bg: 'rgba(30, 64, 175, 0.15)', text: 'rgba(30, 58, 138, 0.9)' },
		dark: { bg: 'rgba(96, 165, 250, 0.3)', text: 'rgba(191, 219, 254, 0.9)' },
	},
	// Ruby - ruby red tones
	ruby: {
		light: { bg: 'rgba(190, 18, 60, 0.15)', text: 'rgba(159, 18, 57, 0.9)' },
		dark: { bg: 'rgba(244, 63, 94, 0.3)', text: 'rgba(253, 164, 175, 0.9)' },
	},
	// SQL/Data - indigo tones
	data: {
		light: { bg: 'rgba(79, 70, 229, 0.15)', text: 'rgba(67, 56, 202, 0.9)' },
		dark: { bg: 'rgba(129, 140, 248, 0.3)', text: 'rgba(199, 210, 254, 0.9)' },
	},
	// PDF/Office documents - warm amber tones
	document: {
		light: { bg: 'rgba(180, 83, 9, 0.15)', text: 'rgba(146, 64, 14, 0.9)' },
		dark: { bg: 'rgba(245, 158, 11, 0.3)', text: 'rgba(253, 230, 138, 0.9)' },
	},
};

/** Map file extensions to color categories */
const EXTENSION_MAP: Record<string, keyof typeof EXTENSION_COLORS> = {
	// TypeScript/JavaScript
	'.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript',
	'.mjs': 'typescript', '.cjs': 'typescript',
	// Markdown/Docs
	'.md': 'markdown', '.mdx': 'markdown', '.txt': 'markdown', '.rst': 'markdown',
	// JSON/Config
	'.json': 'config', '.yaml': 'config', '.yml': 'config', '.toml': 'config',
	'.ini': 'config', '.env': 'config',
	// CSS/Styles
	'.css': 'styles', '.scss': 'styles', '.sass': 'styles', '.less': 'styles', '.styl': 'styles',
	// HTML/Templates
	'.html': 'html', '.htm': 'html', '.xml': 'html', '.svg': 'html',
	// Python
	'.py': 'python', '.pyw': 'python', '.pyi': 'python',
	// Rust
	'.rs': 'rust',
	// Go
	'.go': 'go',
	// Shell
	'.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
	// Images
	'.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
	'.webp': 'image', '.bmp': 'image', '.ico': 'image', '.tiff': 'image', '.avif': 'image',
	// Java/JVM
	'.java': 'java', '.kt': 'java', '.scala': 'java', '.groovy': 'java', '.clj': 'java',
	// C/C++
	'.c': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
	'.cs': 'cpp', '.swift': 'cpp',
	// Ruby
	'.rb': 'ruby', '.erb': 'ruby', '.rake': 'ruby',
	// SQL/Data
	'.sql': 'data', '.db': 'data', '.sqlite': 'data', '.csv': 'data', '.tsv': 'data',
	// PDF/Office documents
	'.pdf': 'document', '.doc': 'document', '.docx': 'document',
	'.xls': 'document', '.xlsx': 'document', '.ppt': 'document', '.pptx': 'document',
};

/**
 * Get color for file extension badge.
 * Returns a visible color based on file type for visual differentiation.
 * Colors adapt to light/dark themes. Unknown extensions use the theme's accent color
 * so that no pill is ever invisible.
 *
 * When colorBlindMode is enabled, delegates to Wong's colorblind-safe palette.
 */
export function getExtensionColor(
	extension: string,
	theme: Theme,
	colorBlindMode?: boolean
): { bg: string; text: string } {
	const isLightTheme = theme.mode === 'light';

	// Colorblind-safe path — never fall through to non-colorblind-safe colors
	if (colorBlindMode) {
		const cbColors = getColorBlindExtensionColor(extension, isLightTheme);
		if (cbColors) return cbColors;
		// Unknown extension in colorblind mode: skip the regular palette and
		// jump straight to the theme accent so we never serve unsafe colors.
		const accentRgb = hexToRgb(theme.colors.accent);
		if (accentRgb) {
			return isLightTheme
				? { bg: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.15)`, text: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.9)` }
				: { bg: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.3)`, text: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.9)` };
		}
		return isLightTheme
			? { bg: 'rgba(107, 114, 128, 0.15)', text: 'rgba(75, 85, 99, 0.9)' }
			: { bg: 'rgba(156, 163, 175, 0.3)', text: 'rgba(209, 213, 219, 0.9)' };
	}

	// Look up extension in the map
	const ext = extension.toLowerCase();
	const category = EXTENSION_MAP[ext];
	if (category) {
		const colors = EXTENSION_COLORS[category];
		return isLightTheme ? colors.light : colors.dark;
	}

	// Default: derive from theme accent so every pill is visible
	const rgb = hexToRgb(theme.colors.accent);
	if (rgb) {
		return isLightTheme
			? { bg: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`, text: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.9)` }
			: { bg: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`, text: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.9)` };
	}

	// Ultimate fallback (non-hex accent like rgb/hsl) — still visible
	return isLightTheme
		? { bg: 'rgba(107, 114, 128, 0.15)', text: 'rgba(75, 85, 99, 0.9)' }
		: { bg: 'rgba(156, 163, 175, 0.3)', text: 'rgba(209, 213, 219, 0.9)' };
}
