/**
 * Tests for colorblind-friendly palette feature across Usage Dashboard charts
 *
 * Verifies:
 * - Colorblind palette constants are properly defined
 * - Charts use colorblind palette when colorBlindMode is enabled
 * - Standard palette is used when colorBlindMode is disabled
 * - All chart components accept colorBlindMode prop
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import type { StatsAggregation } from '../../../../renderer/hooks/useStats';
import { THEMES } from '../../../../shared/themes';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_BINARY_PALETTE,
	COLORBLIND_HEATMAP_SCALE,
	COLORBLIND_LINE_COLORS,
	getColorBlindAgentColor,
	getColorBlindHeatmapColor,
} from '../../../../renderer/constants/colorblindPalettes';

// Test theme
const theme = THEMES['dracula'];

// Sample data for testing
const mockData: StatsAggregation = {
	totalQueries: 50,
	totalDuration: 3600000, // 1 hour
	avgDuration: 72000, // 72 seconds
	byAgent: {
		'claude-code': { count: 30, duration: 2000000 },
		codex: { count: 20, duration: 1600000 },
	},
	bySource: { user: 35, auto: 15 },
	byDay: [
		{ date: '2024-12-20', count: 5, duration: 300000 },
		{ date: '2024-12-21', count: 10, duration: 600000 },
		{ date: '2024-12-22', count: 15, duration: 900000 },
	],
};

describe('Colorblind Palette Constants', () => {
	describe('COLORBLIND_AGENT_PALETTE', () => {
		it('contains 10 distinct colors', () => {
			expect(COLORBLIND_AGENT_PALETTE).toHaveLength(10);
			const uniqueColors = new Set(COLORBLIND_AGENT_PALETTE);
			expect(uniqueColors.size).toBe(10);
		});

		it('contains valid hex color codes', () => {
			const hexPattern = /^#[0-9A-Fa-f]{6}$/;
			COLORBLIND_AGENT_PALETTE.forEach((color) => {
				expect(color).toMatch(hexPattern);
			});
		});

		it('uses Wong colorblind-safe palette colors', () => {
			// Key colors from Wong's palette
			expect(COLORBLIND_AGENT_PALETTE).toContain('#0077BB'); // Strong Blue
			expect(COLORBLIND_AGENT_PALETTE).toContain('#EE7733'); // Orange
			expect(COLORBLIND_AGENT_PALETTE).toContain('#009988'); // Teal
		});
	});

	describe('COLORBLIND_BINARY_PALETTE', () => {
		it('has primary and secondary colors', () => {
			expect(COLORBLIND_BINARY_PALETTE).toHaveProperty('primary');
			expect(COLORBLIND_BINARY_PALETTE).toHaveProperty('secondary');
		});

		it('uses high-contrast blue and orange', () => {
			expect(COLORBLIND_BINARY_PALETTE.primary).toBe('#0077BB');
			expect(COLORBLIND_BINARY_PALETTE.secondary).toBe('#EE7733');
		});
	});

	describe('COLORBLIND_HEATMAP_SCALE', () => {
		it('contains 5 colors for intensity levels 0-4', () => {
			expect(COLORBLIND_HEATMAP_SCALE).toHaveLength(5);
		});

		it('contains valid hex color codes', () => {
			const hexPattern = /^#[0-9A-Fa-f]{6}$/;
			COLORBLIND_HEATMAP_SCALE.forEach((color) => {
				expect(color).toMatch(hexPattern);
			});
		});

		it('provides progressively darker colors', () => {
			// Verify the scale goes from light to dark (viridis-like)
			expect(COLORBLIND_HEATMAP_SCALE[0]).toBe('#FFFFCC'); // Lightest
			expect(COLORBLIND_HEATMAP_SCALE[4]).toBe('#253494'); // Darkest
		});
	});

	describe('COLORBLIND_LINE_COLORS', () => {
		it('has primary color for line charts', () => {
			expect(COLORBLIND_LINE_COLORS.primary).toBe('#0077BB');
		});

		it('has secondary and tertiary colors', () => {
			expect(COLORBLIND_LINE_COLORS.secondary).toBe('#EE7733');
			expect(COLORBLIND_LINE_COLORS.tertiary).toBe('#009988');
		});
	});

	describe('getColorBlindAgentColor', () => {
		it('returns colors from the palette by index', () => {
			expect(getColorBlindAgentColor(0)).toBe(COLORBLIND_AGENT_PALETTE[0]);
			expect(getColorBlindAgentColor(5)).toBe(COLORBLIND_AGENT_PALETTE[5]);
		});

		it('wraps around for indices beyond palette length', () => {
			expect(getColorBlindAgentColor(10)).toBe(COLORBLIND_AGENT_PALETTE[0]);
			expect(getColorBlindAgentColor(15)).toBe(COLORBLIND_AGENT_PALETTE[5]);
		});
	});

	describe('getColorBlindHeatmapColor', () => {
		it('returns colors for intensity levels 0-4', () => {
			expect(getColorBlindHeatmapColor(0)).toBe(COLORBLIND_HEATMAP_SCALE[0]);
			expect(getColorBlindHeatmapColor(2)).toBe(COLORBLIND_HEATMAP_SCALE[2]);
			expect(getColorBlindHeatmapColor(4)).toBe(COLORBLIND_HEATMAP_SCALE[4]);
		});

		it('clamps values outside 0-4 range', () => {
			expect(getColorBlindHeatmapColor(-1)).toBe(COLORBLIND_HEATMAP_SCALE[0]);
			expect(getColorBlindHeatmapColor(5)).toBe(COLORBLIND_HEATMAP_SCALE[4]);
		});
	});
});

describe('AgentComparisonChart with colorBlindMode', () => {
	it('renders with colorBlindMode=false by default', () => {
		render(<AgentComparisonChart data={mockData} theme={theme} />);
		expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
	});

	it('renders with colorBlindMode=true', () => {
		render(<AgentComparisonChart data={mockData} theme={theme} colorBlindMode={true} />);
		expect(screen.getByText('Provider Comparison')).toBeInTheDocument();
	});

	it('uses colorblind palette colors when colorBlindMode is enabled', () => {
		const { container } = render(
			<AgentComparisonChart data={mockData} theme={theme} colorBlindMode={true} />
		);

		// Find the bar elements
		const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
		expect(bars.length).toBeGreaterThan(0);

		// Check that bars use colorblind palette colors
		const firstBar = bars[0] as HTMLElement;
		const color = firstBar.style.backgroundColor;

		// Convert rgb to hex if needed
		const rgbToHex = (rgb: string): string => {
			const match = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
			if (match) {
				const r = parseInt(match[1]).toString(16).padStart(2, '0');
				const g = parseInt(match[2]).toString(16).padStart(2, '0');
				const b = parseInt(match[3]).toString(16).padStart(2, '0');
				return `#${r}${g}${b}`.toUpperCase();
			}
			return rgb.toUpperCase();
		};

		const hexColor = rgbToHex(color);
		const paletteUpper = COLORBLIND_AGENT_PALETTE.map((c) => c.toUpperCase());
		expect(paletteUpper).toContain(hexColor);
	});
});

describe('SourceDistributionChart with colorBlindMode', () => {
	it('renders with colorBlindMode=false by default', () => {
		render(<SourceDistributionChart data={mockData} theme={theme} />);
		expect(screen.getByText('Session Type')).toBeInTheDocument();
	});

	it('renders with colorBlindMode=true', () => {
		render(<SourceDistributionChart data={mockData} theme={theme} colorBlindMode={true} />);
		expect(screen.getByText('Session Type')).toBeInTheDocument();
	});

	it('renders both Interactive and Auto Run labels', () => {
		render(<SourceDistributionChart data={mockData} theme={theme} colorBlindMode={true} />);
		expect(screen.getByText('Interactive')).toBeInTheDocument();
		expect(screen.getByText('Auto Run')).toBeInTheDocument();
	});
});

describe('ActivityHeatmap with colorBlindMode', () => {
	it('renders with colorBlindMode=false by default', () => {
		render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
		expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
	});

	it('renders with colorBlindMode=true', () => {
		render(
			<ActivityHeatmap data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
		);
		expect(screen.getByText('Activity Heatmap')).toBeInTheDocument();
	});

	it('renders legend with intensity scale', () => {
		render(
			<ActivityHeatmap data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
		);
		expect(screen.getByText('Less')).toBeInTheDocument();
		expect(screen.getByText('More')).toBeInTheDocument();
	});
});

describe('DurationTrendsChart with colorBlindMode', () => {
	it('renders with colorBlindMode=false by default', () => {
		render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
		expect(screen.getByText('Duration Trends')).toBeInTheDocument();
	});

	it('renders with colorBlindMode=true', () => {
		render(
			<DurationTrendsChart data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
		);
		expect(screen.getByText('Duration Trends')).toBeInTheDocument();
	});

	it('renders smoothing toggle', () => {
		render(
			<DurationTrendsChart data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
		);
		expect(screen.getByText('Smoothing:')).toBeInTheDocument();
	});
});

describe('Colorblind mode color accessibility', () => {
	it('colorblind palette colors are distinct in grayscale', () => {
		// Convert hex to grayscale luminance (approximate perceptual brightness)
		const hexToLuminance = (hex: string): number => {
			const r = parseInt(hex.slice(1, 3), 16);
			const g = parseInt(hex.slice(3, 5), 16);
			const b = parseInt(hex.slice(5, 7), 16);
			// Relative luminance formula
			return 0.299 * r + 0.587 * g + 0.114 * b;
		};

		const luminances = COLORBLIND_AGENT_PALETTE.slice(0, 6).map(hexToLuminance);

		// Check that luminances have reasonable spread (not all the same)
		const minLum = Math.min(...luminances);
		const maxLum = Math.max(...luminances);
		expect(maxLum - minLum).toBeGreaterThan(50); // At least 50 units of luminance difference
	});

	it('binary palette has high contrast between primary and secondary', () => {
		const hexToLuminance = (hex: string): number => {
			const r = parseInt(hex.slice(1, 3), 16);
			const g = parseInt(hex.slice(3, 5), 16);
			const b = parseInt(hex.slice(5, 7), 16);
			return 0.299 * r + 0.587 * g + 0.114 * b;
		};

		const primaryLum = hexToLuminance(COLORBLIND_BINARY_PALETTE.primary);
		const secondaryLum = hexToLuminance(COLORBLIND_BINARY_PALETTE.secondary);

		// Should have at least 30 units of luminance difference
		expect(Math.abs(primaryLum - secondaryLum)).toBeGreaterThan(30);
	});

	it('heatmap scale has progressive luminance increase', () => {
		const hexToLuminance = (hex: string): number => {
			const r = parseInt(hex.slice(1, 3), 16);
			const g = parseInt(hex.slice(3, 5), 16);
			const b = parseInt(hex.slice(5, 7), 16);
			return 0.299 * r + 0.587 * g + 0.114 * b;
		};

		const luminances = COLORBLIND_HEATMAP_SCALE.map(hexToLuminance);

		// First color should be brightest, last should be darkest
		expect(luminances[0]).toBeGreaterThan(luminances[4]);

		// Generally decreasing trend (may not be strictly monotonic due to hue shifts)
		expect(luminances[0]).toBeGreaterThan(luminances[2]);
		expect(luminances[2]).toBeGreaterThan(luminances[4]);
	});
});
