// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/UsageDashboard/colorblind-palette.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/SessionStats.test.tsx
import { describe, it, expect } from 'vitest';
import { render as s1_render, screen as s1_screen } from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import { SourceDistributionChart } from '../../../../renderer/components/UsageDashboard/SourceDistributionChart';
import { ActivityHeatmap } from '../../../../renderer/components/UsageDashboard/ActivityHeatmap';
import { DurationTrendsChart } from '../../../../renderer/components/UsageDashboard/DurationTrendsChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import { THEMES as S1_THEMES } from '../../../../shared/themes';
import {
	COLORBLIND_AGENT_PALETTE,
	COLORBLIND_BINARY_PALETTE,
	COLORBLIND_HEATMAP_SCALE,
	COLORBLIND_LINE_COLORS,
	getColorBlindAgentColor,
	getColorBlindHeatmapColor,
} from '../../../../renderer/constants/colorblindPalettes';
import { render as s2_render, screen as s2_screen } from '@testing-library/react';
import { SessionStats } from '../../../../renderer/components/UsageDashboard/SessionStats';
import type { Session } from '../../../../renderer/types';
import { THEMES as S2_THEMES } from '../../../../shared/themes';
// Source: src/__tests__/renderer/components/UsageDashboard/colorblind-palette.test.tsx
describe('', () => {
	// Test theme
	const theme = S1_THEMES['dracula'];
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
			s1_render(<AgentComparisonChart data={mockData} theme={theme} />);
			expect(s1_screen.getByText('Provider Comparison')).toBeInTheDocument();
		});
		it('renders with colorBlindMode=true', () => {
			s1_render(<AgentComparisonChart data={mockData} theme={theme} colorBlindMode={true} />);
			expect(s1_screen.getByText('Provider Comparison')).toBeInTheDocument();
		});
		it('uses colorblind palette colors when colorBlindMode is enabled', () => {
			const { container } = s1_render(
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
			s1_render(<SourceDistributionChart data={mockData} theme={theme} />);
			expect(s1_screen.getByText('Session Type')).toBeInTheDocument();
		});
		it('renders with colorBlindMode=true', () => {
			s1_render(<SourceDistributionChart data={mockData} theme={theme} colorBlindMode={true} />);
			expect(s1_screen.getByText('Session Type')).toBeInTheDocument();
		});
		it('renders both Interactive and Auto Run labels', () => {
			s1_render(<SourceDistributionChart data={mockData} theme={theme} colorBlindMode={true} />);
			expect(s1_screen.getByText('Interactive')).toBeInTheDocument();
			expect(s1_screen.getByText('Auto Run')).toBeInTheDocument();
		});
	});
	describe('ActivityHeatmap with colorBlindMode', () => {
		it('renders with colorBlindMode=false by default', () => {
			s1_render(<ActivityHeatmap data={mockData} timeRange="week" theme={theme} />);
			expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});
		it('renders with colorBlindMode=true', () => {
			s1_render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
			);
			expect(s1_screen.getByText('Activity Heatmap')).toBeInTheDocument();
		});
		it('renders legend with intensity scale', () => {
			s1_render(
				<ActivityHeatmap data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
			);
			expect(s1_screen.getByText('Less')).toBeInTheDocument();
			expect(s1_screen.getByText('More')).toBeInTheDocument();
		});
	});
	describe('DurationTrendsChart with colorBlindMode', () => {
		it('renders with colorBlindMode=false by default', () => {
			s1_render(<DurationTrendsChart data={mockData} timeRange="week" theme={theme} />);
			expect(s1_screen.getByText('Duration Trends')).toBeInTheDocument();
		});
		it('renders with colorBlindMode=true', () => {
			s1_render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
			);
			expect(s1_screen.getByText('Duration Trends')).toBeInTheDocument();
		});
		it('renders smoothing toggle', () => {
			s1_render(
				<DurationTrendsChart data={mockData} timeRange="week" theme={theme} colorBlindMode={true} />
			);
			expect(s1_screen.getByText('Smoothing:')).toBeInTheDocument();
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
});
// Source: src/__tests__/renderer/components/UsageDashboard/SessionStats.test.tsx
describe('', () => {
	const theme = S2_THEMES['dracula'];
	let idCounter = 0;
	function makeSession(overrides: Partial<Session> = {}): Session {
		idCounter++;
		return {
			id: `s${idCounter}`,
			name: `Session ${idCounter}`,
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/tmp',
			fullPath: '/tmp',
			projectRoot: '/tmp',
			aiLogs: [],
			shellLogs: [],
			workLog: [],
			contextUsage: 0,
			inputMode: 'ai',
			aiPid: 0,
			terminalPid: 0,
			port: 0,
			isLive: false,
			changedFiles: [],
			isGitRepo: false,
			fileTree: [],
			fileExplorerExpanded: [],
			fileExplorerScrollPos: 0,
			createdAt: 0,
			...overrides,
		} as Session;
	}
	describe('SessionStats - worktree breakdown', () => {
		it('renders the Regular | Worktree stat pair when sessions exist', () => {
			const sessions = [
				makeSession(),
				makeSession({ parentSessionId: 'parent-1' }),
				makeSession({ parentSessionId: 'parent-1' }),
			];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			const breakdown = s2_screen.getByTestId('worktree-breakdown');
			expect(breakdown).toBeInTheDocument();
			expect(breakdown.textContent).toContain('Regular:');
			expect(breakdown.textContent).toContain('1');
			expect(breakdown.textContent).toContain('Worktree:');
			expect(breakdown.textContent).toContain('2');
		});
		it('counts parent agents (worktreeConfig set) as Regular, not Worktree', () => {
			const sessions = [
				makeSession({ worktreeConfig: { basePath: '/tmp/wt', watchEnabled: true } }),
				makeSession({ parentSessionId: 'parent-1' }),
			];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			const breakdown = s2_screen.getByTestId('worktree-breakdown');
			expect(breakdown).toHaveAttribute('aria-label', 'Regular: 1 | Worktree: 1');
		});
		it('shows zero counts when there are no worktree children', () => {
			const sessions = [makeSession(), makeSession()];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			const breakdown = s2_screen.getByTestId('worktree-breakdown');
			expect(breakdown).toHaveAttribute('aria-label', 'Regular: 2 | Worktree: 0');
		});
		it('excludes terminal sessions from the worktree breakdown', () => {
			const sessions = [
				makeSession({ toolType: 'terminal' }),
				makeSession({ toolType: 'terminal', parentSessionId: 'p1' }),
				makeSession(),
				makeSession({ parentSessionId: 'p2' }),
			];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			const breakdown = s2_screen.getByTestId('worktree-breakdown');
			expect(breakdown).toHaveAttribute('aria-label', 'Regular: 1 | Worktree: 1');
		});
		it('does not render the breakdown row when no agent sessions exist', () => {
			s2_render(<SessionStats sessions={[]} theme={theme} />);
			expect(s2_screen.queryByTestId('worktree-breakdown')).not.toBeInTheDocument();
		});
	});
	describe('SessionStats - agent type display names', () => {
		it('shows the user-assigned name when only one session of that type exists', () => {
			const sessions = [makeSession({ name: 'Backend API', toolType: 'claude-code' })];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			expect(s2_screen.getByText('Backend API')).toBeInTheDocument();
			expect(s2_screen.queryByText('Claude Code')).not.toBeInTheDocument();
		});
		it('shows the prettified type when multiple sessions share the type', () => {
			const sessions = [
				makeSession({ name: 'Frontend', toolType: 'claude-code' }),
				makeSession({ name: 'Backend', toolType: 'claude-code' }),
			];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			expect(s2_screen.getByText('Claude Code')).toBeInTheDocument();
			expect(s2_screen.queryByText('Frontend')).not.toBeInTheDocument();
			expect(s2_screen.queryByText('Backend')).not.toBeInTheDocument();
		});
		it('uses canonical display names for known agent types via shared resolver', () => {
			const sessions = [
				makeSession({ name: 'A', toolType: 'opencode' }),
				makeSession({ name: 'B', toolType: 'opencode' }),
				makeSession({ name: 'C', toolType: 'factory-droid' }),
				makeSession({ name: 'D', toolType: 'factory-droid' }),
			];
			s2_render(<SessionStats sessions={sessions} theme={theme} />);
			expect(s2_screen.getByText('OpenCode')).toBeInTheDocument();
			expect(s2_screen.getByText('Factory Droid')).toBeInTheDocument();
		});
	});
	describe('SessionStats - active agents in range', () => {
		const buildData = (
			bySessionByDay: Record<
				string,
				Array<{
					date: string;
					count: number;
					duration: number;
				}>
			>
		) =>
			({
				totalQueries: 0,
				totalDuration: 0,
				avgDuration: 0,
				byAgent: {},
				bySource: { user: 0, auto: 0 },
				byLocation: { local: 0, remote: 0 },
				byDay: [],
				byHour: [],
				totalSessions: 0,
				sessionsByAgent: {},
				sessionsByDay: [],
				avgSessionDuration: 0,
				byAgentByDay: {},
				bySessionByDay,
				bySessionSource: {},
			}) as never;
		it('reports how many agents ran a query in the range', () => {
			const active = makeSession();
			const idle = makeSession();
			s2_render(
				<SessionStats
					sessions={[active, idle]}
					theme={theme}
					data={buildData({ [active.id]: [{ date: '2026-09-01', count: 3, duration: 500 }] })}
				/>
			);
			expect(s2_screen.getByText('1 active')).toBeInTheDocument();
		});
		it('shares the footnote line with the bookmarked count', () => {
			const active = makeSession({ bookmarked: true });
			const idle = makeSession();
			s2_render(
				<SessionStats
					sessions={[active, idle]}
					theme={theme}
					data={buildData({ [active.id]: [{ date: '2026-09-01', count: 3, duration: 500 }] })}
				/>
			);
			expect(s2_screen.getByText('1 active \u00b7 1 bookmarked')).toBeInTheDocument();
		});
		it('omits the active line entirely when no stats are supplied', () => {
			s2_render(<SessionStats sessions={[makeSession()]} theme={theme} />);
			expect(s2_screen.queryByText(/active/)).not.toBeInTheDocument();
		});
	});
});
