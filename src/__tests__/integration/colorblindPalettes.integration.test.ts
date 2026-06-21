import { describe, expect, it } from 'vitest';

import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_EXTENSION_PALETTE,
	COLORBLIND_HEATMAP_SCALE,
	getColorBlindAgentColor,
	getColorBlindExtensionColor,
	getColorBlindHeatmapColor,
	getColorBlindPattern,
} from '../../renderer/constants/colorblindPalettes';

describe('colorblind palette utilities integration', () => {
	it('wraps agent colors, clamps heatmap intensity, and cycles patterns', () => {
		expect(getColorBlindAgentColor(0)).toBe(COLORBLIND_AGENT_PALETTE[0]);
		expect(getColorBlindAgentColor(COLORBLIND_AGENT_PALETTE.length + 1)).toBe(
			COLORBLIND_AGENT_PALETTE[1]
		);

		expect(getColorBlindHeatmapColor(-10)).toBe(COLORBLIND_HEATMAP_SCALE[0]);
		expect(getColorBlindHeatmapColor(1.6)).toBe(COLORBLIND_HEATMAP_SCALE[2]);
		expect(getColorBlindHeatmapColor(99)).toBe(COLORBLIND_HEATMAP_SCALE[4]);

		expect(getColorBlindPattern(0)).toBe('solid');
		expect(getColorBlindPattern(7)).toBe('diagonal');
	});

	it.each([
		['.tsx', COLORBLIND_EXTENSION_PALETTE.typescript],
		['.mdx', COLORBLIND_EXTENSION_PALETTE.markdown],
		['.yaml', COLORBLIND_EXTENSION_PALETTE.config],
		['.scss', COLORBLIND_EXTENSION_PALETTE.styles],
		['.svg', COLORBLIND_EXTENSION_PALETTE.html],
		['.pyi', COLORBLIND_EXTENSION_PALETTE.python],
		['.rs', COLORBLIND_EXTENSION_PALETTE.rust],
		['.go', COLORBLIND_EXTENSION_PALETTE.go],
		['.zsh', COLORBLIND_EXTENSION_PALETTE.shell],
		['.avif', COLORBLIND_EXTENSION_PALETTE.image],
		['.kt', COLORBLIND_EXTENSION_PALETTE.java],
		['.swift', COLORBLIND_EXTENSION_PALETTE.cpp],
		['.rake', COLORBLIND_EXTENSION_PALETTE.ruby],
		['.tsv', COLORBLIND_EXTENSION_PALETTE.data],
		['.pptx', COLORBLIND_EXTENSION_PALETTE.document],
	])('returns colorblind-safe extension colors for %s', (extension, palette) => {
		expect(getColorBlindExtensionColor(extension, true)).toEqual(palette.light);
		expect(getColorBlindExtensionColor(extension.toUpperCase(), false)).toEqual(palette.dark);
	});

	it('returns null for unknown extensions so callers can use theme fallbacks', () => {
		expect(getColorBlindExtensionColor('.unknown', true)).toBeNull();
	});
});
